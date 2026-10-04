import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilePlus2, FileText, Globe, Monitor, Play, Power, RefreshCw, Save, SquareTerminal } from 'lucide-react';
import { botApi } from './api';
import type { Bot, BrowserView, ComputerFileEntry, ComputerStatus, TerminalResult } from './api';
import './computer.css';

const emptyStatus: ComputerStatus = {
  enabled: false,
  state: 'DISABLED',
  workspaceReady: false,
  browser: { state: 'STOPPED' },
  terminal: { enabled: false, allowedPrograms: [] }
};

export function ComputerPanel({ bot, connected }: { bot: Bot; connected: boolean }) {
  const base = `/bots/${encodeURIComponent(bot.id)}/computer`;
  const [status, setStatus] = useState<ComputerStatus>(emptyStatus);
  const [files, setFiles] = useState<ComputerFileEntry[]>([]);
  const [browserUrl, setBrowserUrl] = useState('https://example.com');
  const [browserView, setBrowserView] = useState<BrowserView>();
  const [program, setProgram] = useState('node');
  const [argsText, setArgsText] = useState('--version');
  const [terminalResult, setTerminalResult] = useState<TerminalResult>();
  const [filePath, setFilePath] = useState('notes.md');
  const [fileContent, setFileContent] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const canBrowse = bot.tools.includes('browser_open');
  const canRead = bot.tools.includes('file_read');
  const canWrite = bot.tools.includes('file_write');
  const canTerminal = bot.tools.includes('terminal_exec');

  const refresh = useCallback(async () => {
    if (!connected) return;
    try {
      const next = await botApi<ComputerStatus>(base);
      setStatus(next);
      if (canRead || canWrite) setFiles(await botApi<ComputerFileEntry[]>(`${base}/files`));
      else setFiles([]);
      if (!program && next.terminal.allowedPrograms[0]) setProgram(next.terminal.allowedPrograms[0]);
    } catch (err) { setError((err as Error).message); }
  }, [base, canRead, canWrite, connected, program]);

  useEffect(() => { void refresh(); }, [refresh]);

  const fileOnly = useMemo(() => files.filter(entry => entry.type === 'file'), [files]);

  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name); setError('');
    try { await fn(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  if (!connected) return <div className="ab-computer-empty"><Monitor size={34} /><h3>Computer runtime is not connected</h3><p>This deployment has not enabled the bounded Aira Bot computer provider.</p></div>;

  return <div className="ab-computer-panel">
    <div className="ab-computer-status">
      <div><span className={`ab-computer-dot ${status.state === 'RUNNING' ? 'is-running' : ''}`} /><strong>{status.state === 'RUNNING' ? 'Browser running' : 'Computer ready'}</strong><small>{status.workspaceReady ? 'Persistent workspace mounted' : 'Workspace creates on first use'}</small></div>
      <div className="ab-computer-actions">
        <button className="ab-icon-button" aria-label="Refresh computer" onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={15} /></button>
        {canBrowse && (status.browser.state === 'RUNNING'
          ? <button className="ab-secondary" disabled={!!busy} onClick={() => void action('stop', async () => { setStatus(await botApi<ComputerStatus>(`${base}/stop`, { method: 'POST' })); })}><Power size={14} />Stop browser</button>
          : <button className="ab-secondary" disabled={!!busy} onClick={() => void action('start', async () => { setStatus(await botApi<ComputerStatus>(`${base}/start`, { method: 'POST' })); })}><Play size={14} />Start browser</button>)}
      </div>
    </div>

    {error && <p className="ab-error" role="alert">{error}</p>}

    <section className="ab-computer-section">
      <header><Globe size={16} /><div><strong>Browser</strong><small>Public HTTP(S) navigation only</small></div></header>
      {canBrowse ? <>
        <form className="ab-inline-form" onSubmit={event => { event.preventDefault(); void action('browser', async () => { const view = await botApi<BrowserView>(`${base}/browser/open`, { method: 'POST', body: JSON.stringify({ url: browserUrl }) }); setBrowserView(view); setStatus(await botApi<ComputerStatus>(base)); }); }}>
          <input type="url" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} required aria-label="Browser URL" />
          <button className="ab-primary" disabled={!!busy}>Open</button>
        </form>
        {browserView && <div className="ab-browser-view"><strong>{browserView.title || browserView.url}</strong><a href={browserView.url} target="_blank" rel="noreferrer">{browserView.url}</a><p>{browserView.text.slice(0, 1200) || 'No visible body text.'}</p><small>Viewport captured to {browserView.screenshotPath}</small></div>}
      </> : <p className="ab-muted">Enable Browser in this bot’s capabilities.</p>}
    </section>

    <section className="ab-computer-section">
      <header><SquareTerminal size={16} /><div><strong>Terminal</strong><small>Direct allowlisted programs · no command shell</small></div></header>
      {canTerminal && status.terminal.enabled ? <>
        <form className="ab-terminal-form" onSubmit={event => { event.preventDefault(); void action('terminal', async () => { setTerminalResult(await botApi<TerminalResult>(`${base}/terminal`, { method: 'POST', body: JSON.stringify({ program, args: argsText.split('\n').filter(Boolean), confirm: true }) })); }); }}>
          <select value={program} onChange={event => setProgram(event.target.value)}>{status.terminal.allowedPrograms.map(item => <option key={item}>{item}</option>)}</select>
          <textarea rows={2} value={argsText} onChange={event => setArgsText(event.target.value)} placeholder="One argument per line" aria-label="Terminal arguments" />
          <button className="ab-primary" disabled={!!busy || !program}>Run</button>
        </form>
        {terminalResult && <pre className="ab-terminal-output">$ {terminalResult.program} {terminalResult.args.join(' ')}\n{terminalResult.stdout}{terminalResult.stderr ? `\n${terminalResult.stderr}` : ''}\n[exit {terminalResult.exitCode}]</pre>}
      </> : <p className="ab-muted">{canTerminal ? 'Terminal execution is disabled by this host.' : 'Enable Terminal programs in this bot’s capabilities.'}</p>}
    </section>

    <section className="ab-computer-section">
      <header><FileText size={16} /><div><strong>Workspace files</strong><small>Persistent per-bot files · symlinks rejected</small></div></header>
      {(canRead || canWrite) ? <>
        <div className="ab-file-browser">
          <div className="ab-file-list">{fileOnly.length ? fileOnly.map(entry => <button key={entry.path} onClick={() => void action('read', async () => { const result = await botApi<{ path: string; content: string }>(`${base}/file?path=${encodeURIComponent(entry.path)}`); setFilePath(result.path); setFileContent(result.content); })} disabled={!canRead}><FileText size={14} /><span>{entry.path}</span><small>{entry.sizeBytes} B</small></button>) : <p className="ab-muted">No workspace files yet.</p>}</div>
          <div className="ab-file-editor">
            <label>Path<input value={filePath} onChange={event => setFilePath(event.target.value)} disabled={!canWrite} /></label>
            <label>Content<textarea rows={7} value={fileContent} onChange={event => setFileContent(event.target.value)} readOnly={!canWrite} /></label>
            <div>{canWrite && <button className="ab-primary" disabled={!!busy || !filePath} onClick={() => void action('write', async () => { await botApi(`${base}/file`, { method: 'PUT', body: JSON.stringify({ path: filePath, content: fileContent, confirm: true }) }); await refresh(); })}><Save size={14} />Save</button>}<button className="ab-secondary" onClick={() => { setFilePath('notes.md'); setFileContent(''); }}><FilePlus2 size={14} />New</button></div>
          </div>
        </div>
      </> : <p className="ab-muted">Enable workspace file read or write for this bot.</p>}
    </section>
  </div>;
}
