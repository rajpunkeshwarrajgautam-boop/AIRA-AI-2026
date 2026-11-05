#!/usr/bin/env python3
"""
AIRA AI 2026 — Isolated Container Sidecar Sandbox Runner
-------------------------------------------------------
Executes untrusted Python scripts and commands in an isolated container
without mounting the host Docker socket (/var/run/docker.sock) to the worker.

Security controls:
- Non-root execution (nobody:nogroup)
- Read-only container rootfs with isolated tmpfs scratchpads
- Dropped Linux capabilities (ALL) and no-new-privileges
- Internal Docker bridge networking (internal: true — zero external egress)
- Process group isolation & process-tree termination on timeout
- Subprocess resource limits (RLIMIT_NPROC, RLIMIT_NOFILE, RLIMIT_FSIZE)
- Path traversal & workspace escape prevention
- Optional Bearer token authentication (AIRA_SANDBOX_AUTH_TOKEN)
- Strict workspace file limits and sanitized environment variables
"""

import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

try:
    import resource
except ImportError:
    resource = None

PORT = int(os.environ.get("PORT", "8000"))
BASE_WORKSPACE_DIR = Path(os.environ.get("WORKSPACE_BASE", "/tmp/workspaces"))
AUTH_TOKEN = os.environ.get("AIRA_SANDBOX_AUTH_TOKEN", "").strip()
MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB ceiling per file
MAX_TOTAL_OUTPUT_FILES = 100
MAX_WORKSPACE_TOTAL_BYTES = 50 * 1024 * 1024  # 50 MB total quota per workspace
MAX_PAYLOAD_BYTES = int(os.environ.get("MAX_PAYLOAD_BYTES", str(10 * 1024 * 1024)))

# Ensure base directory exists
BASE_WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)


def sanitize_workspace_id(ws_id: str) -> str:
    """Ensure workspace ID is strictly alphanumeric and safe from directory traversal."""
    if not ws_id:
        raise ValueError("Workspace ID cannot be empty.")
    safe_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    if not all(c in safe_chars for c in ws_id):
        raise ValueError(f"Invalid characters in workspaceId: {ws_id}")
    return ws_id


def resolve_safe_path(base_dir: Path, rel_path: str) -> Path:
    """Resolve a relative path strictly within base_dir, preventing traversal escapes."""
    if "\0" in rel_path:
        raise ValueError(f"Null byte detected in path: {rel_path}")
    clean_rel = rel_path.replace("\\", "/").strip()
    if clean_rel.startswith("/") or (len(clean_rel) > 1 and clean_rel[1] == ":"):
        raise ValueError(f"Absolute path not permitted: {rel_path}")

    parts = [p for p in clean_rel.split("/") if p and p != "."]
    if not parts:
        raise ValueError(f"Invalid path: {rel_path}")

    for part in parts:
        if ".." in part or (len(part) > 1 and all(c == "." for c in part)):
            raise ValueError(f"Path traversal detected: {rel_path}")

    resolved = (base_dir / "/".join(parts)).resolve()
    base_resolved = base_dir.resolve()
    if not str(resolved).startswith(str(base_resolved)):
        raise ValueError(f"Target path escapes workspace root: {rel_path}")
    return resolved


def kill_process_tree(pid: int):
    """Terminates an entire process tree across both POSIX and Windows."""
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=5)
        except Exception:
            pass
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass


def set_subprocess_limits():
    """Sets a new session/process group and caps process resources on Unix."""
    if sys.platform != "win32":
        try:
            os.setsid()
        except Exception:
            pass
    if resource is not None:
        try:
            # Cap maximum child processes to prevent fork-bombs
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        except Exception:
            pass
        try:
            # Cap open file descriptors
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        except Exception:
            pass
        try:
            # Cap maximum single file write size to 20MB
            resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 * 1024, 20 * 1024 * 1024))
        except Exception:
            pass


class SandboxRequestHandler(http.server.BaseHTTPRequestHandler):
    server_version = "AiraSandboxSidecar/2026.1.0"

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, message: str):
        self._send_json(status, {"error": message})

    def _check_auth(self) -> bool:
        if not AUTH_TOKEN:
            return True
        auth_header = self.headers.get("Authorization", "")
        if auth_header == f"Bearer {AUTH_TOKEN}":
            return True
        self._send_error(401, "UNAUTHORIZED: Invalid or missing Bearer authentication token.")
        return False

    def do_GET(self):
        # Health probe is unauthenticated for cluster supervisors
        if self.path == "/health":
            self._send_json(200, {
                "status": "HEALTHY",
                "runner": "aira-sandbox-sidecar",
                "pythonVersion": sys.version.split()[0],
                "workspaceBase": str(BASE_WORKSPACE_DIR),
                "authRequired": bool(AUTH_TOKEN)
            })
            return

        if not self._check_auth():
            return

        self._send_error(404, "Endpoint not found.")

    def do_POST(self):
        if not self._check_auth():
            return

        try:
            content_len = int(self.headers.get("Content-Length", 0))
            if content_len > MAX_PAYLOAD_BYTES:
                try:
                    self.rfile.read(min(content_len, 1024 * 1024))
                except Exception:
                    pass
                self._send_error(413, "Payload too large.")
                return

            body = self.rfile.read(content_len)
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self._send_error(400, f"Invalid JSON payload: {e}")
            return

        if self.path == "/workspaces":
            ws_id = payload.get("workspaceId")
            if not ws_id:
                self._send_error(400, "Missing workspaceId.")
                return
            try:
                safe_id = sanitize_workspace_id(ws_id)
                ws_path = BASE_WORKSPACE_DIR / safe_id
                ws_path.mkdir(parents=True, exist_ok=True)
                if sys.platform != "win32":
                    try:
                        os.chmod(ws_path, 0o700)
                    except Exception:
                        pass
                self._send_json(201, {"status": "CREATED", "workspaceId": safe_id})
            except Exception as e:
                self._send_error(400, f"Failed to initialize workspace: {e}")
            return

        if self.path == "/run":
            ws_id = payload.get("workspaceId")
            command = payload.get("command")
            files = payload.get("files", {})
            timeout_ms = payload.get("timeoutMs", 30000)

            if not ws_id or not command:
                self._send_error(400, "Missing workspaceId or command.")
                return

            try:
                safe_id = sanitize_workspace_id(ws_id)
                ws_dir = (BASE_WORKSPACE_DIR / safe_id).resolve()
                ws_dir.mkdir(parents=True, exist_ok=True)
                if sys.platform != "win32":
                    try:
                        os.chmod(ws_dir, 0o700)
                    except Exception:
                        pass
            except Exception as e:
                self._send_error(400, f"Invalid workspace directory: {e}")
                return

            # 1. Write input files into the workspace
            try:
                total_written = 0
                if isinstance(files, dict):
                    for file_path, content in files.items():
                        target_file = resolve_safe_path(ws_dir, file_path)
                        target_file.parent.mkdir(parents=True, exist_ok=True)
                        if isinstance(content, str):
                            raw_bytes = content.encode("utf-8")
                        elif isinstance(content, bytes):
                            raw_bytes = content
                        else:
                            continue

                        total_written += len(raw_bytes)
                        if total_written > MAX_WORKSPACE_TOTAL_BYTES:
                            self._send_error(413, "Workspace storage quota exceeded (50MB limit).")
                            return

                        target_file.write_bytes(raw_bytes)
            except Exception as e:
                self._send_error(400, f"Failed to write workspace files: {e}")
                return

            # 2. Execute command under sanitized unprivileged environment
            timeout_sec = max(1.0, min(float(timeout_ms) / 1000.0, 300.0))
            sanitized_env = {
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "HOME": "/tmp",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
                "LANG": "C.UTF-8"
            }

            start_time = time.time()
            preexec = set_subprocess_limits if sys.platform != "win32" else None

            try:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    cwd=str(ws_dir),
                    env=sanitized_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    preexec_fn=preexec
                )
                try:
                    stdout, stderr = proc.communicate(timeout=timeout_sec)
                    exit_code = proc.returncode
                except subprocess.TimeoutExpired:
                    kill_process_tree(proc.pid)
                    try:
                        stdout, stderr = proc.communicate(timeout=2)
                    except Exception:
                        stdout, stderr = "", ""
                    exit_code = 124  # Standard UNIX timeout exit code
                    stderr = f"Execution timed out after {timeout_sec:.1f}s (process tree terminated)."
                duration_ms = int((time.time() - start_time) * 1000)
            except Exception as e:
                duration_ms = int((time.time() - start_time) * 1000)
                exit_code = 1
                stdout = ""
                stderr = f"Command execution failed: {e}"

            # 3. Read back modified / created text files from workspace
            collected_files = {}
            try:
                count = 0
                for item in ws_dir.rglob("*"):
                    if item.is_file() and count < MAX_TOTAL_OUTPUT_FILES:
                        rel = str(item.relative_to(ws_dir)).replace("\\", "/")
                        if rel.startswith(".git") or "__pycache__" in rel or rel.endswith(".pyc"):
                            continue
                        if item.stat().st_size <= MAX_FILE_SIZE_BYTES:
                            try:
                                collected_files[rel] = item.read_text(encoding="utf-8")
                                count += 1
                            except UnicodeDecodeError:
                                # Skip binary files
                                pass
            except Exception:
                pass

            self._send_json(200, {
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "durationMs": duration_ms,
                "files": collected_files
            })
            return

        self._send_error(404, "Endpoint not found.")

    def do_DELETE(self):
        if not self._check_auth():
            return

        if self.path.startswith("/workspaces/"):
            ws_id = self.path.replace("/workspaces/", "").strip()
            try:
                safe_id = sanitize_workspace_id(ws_id)
                ws_dir = BASE_WORKSPACE_DIR / safe_id
                if ws_dir.exists():
                    shutil.rmtree(ws_dir, ignore_errors=True)
                self._send_json(200, {"status": "TERMINATED", "workspaceId": safe_id})
            except Exception as e:
                self._send_error(400, f"Failed to delete workspace: {e}")
            return
        self._send_error(404, "Endpoint not found.")

    def log_message(self, format, *args):
        # Scrub credentials from logs — log HTTP method, path and status code only
        sys.stderr.write(f"[SandboxRunner] {args[0]} - {args[1]}\n")


def run_server():
    server_address = ("0.0.0.0", PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, SandboxRequestHandler)
    print(f"[SandboxRunner] Listening on 0.0.0.0:{PORT} (Workspace dir: {BASE_WORKSPACE_DIR}, Auth: {'Enabled' if AUTH_TOKEN else 'Disabled'})")

    def handle_shutdown(signum, frame):
        print("[SandboxRunner] Received shutdown signal, closing...")
        httpd.server_close()
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run_server()
