import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilePlus2, FileText, Globe, Hand, Monitor, MousePointer2, Play, Power, RefreshCw, Save, SquareTerminal, Undo2 } from 'lucide-react';
import { botApi } from './api';
import type { Bot, BrowserView, ComputerEvent, ComputerFileEntry, ComputerStatus, ComputerTakeover, TerminalResult } from './api';
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
  const tokenKey = `aira_bot_computer_lease_${bot.id}`;
  const [status, setStatus] = useState<ComputerStatus>(emptyStatus);
  const [files, setFiles] = useState<ComputerFileEntry[]>([]);
  const [events, setEvents] = useState<ComputerEvent[]>([]);
  const [leaseToken, setLeaseToken] = useState(() => sessionStorage.getItem(tokenKey) || '');
  const [browserUrl, setBrowserUrl] = useState('https://example.com');
  const [browserSelector, setBrowserSelector] = useState('');
  const [browserText, setBrowserText] = useState('');
  const [browserView, setBrowserView] = useState<BrowserView>();
  const [program, setProgram] = useState('node');
  const [argsText, setArgsText] = useState('--version');
  const [terminalResult, setTerminalResult] = useState<TerminalResult>();
  const [filePath, setFilePath] = useState('notes.md');
  const [fileContent, setFileContent] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const canBrowse = bot.tools.includes('browser_open');
  const canClick = bot.tools.includes('browser_click');
  const canType = bot.tools.includes('browser_type');
  const canScroll = bot.tools.includes('browser_scroll');
  const canWait = bot.tools.includes('browser_wait');
  const canRead = bot.tools.includes('file_read');
  const canWrite = bot.tools.includes('file_write');
  const canTerminal = bot.tools.includes('terminal_exec');
  const hasManualComputer = canBrowse || canClick || canType || canScroll || canWait || canWrite || canTerminal;
  const hasOurControl = Boolean(leaseToken && status.humanControl);
  const controlledElsewhere = Boolean(status.humanControl && !leaseToken);
  const leaseHeaders = leaseToken ? { 'x-aira-computer-lease': leaseToken } : {};

  const refresh = useCallback(async () => {
    if (!connected) return;
    try {
      const next = await botApi<ComputerStatus>(base);
      setStatus(next);
      if (canRead || canWrite) setFiles(await botApi<ComputerFileEntry[]>(`${base}/files`));
      else setFiles([]);
      if (!program && next.terminal.allowedPrograms[0]) setProgram(next.terminal.allowedPrograms[0]);
      const after = events.at(-1)?.sequence || 0;
      const nextEvents = await botApi<ComputerEvent[]>(`${base}/events?after=${after}`);
      if (nextEvents.length) setEvents(prev => [...prev, ...nextEvents].slice(-60));
    } catch (err) { setError((err as Error).message); }
  }, [base, canRead, canWrite, connected, events, program]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [connected, refresh]);

  const fileOnly = useMemo(() => files.filter(entry => entry.type === 'file'), [files]);

  async function action(name: string, fn: () => Promise<void>) {
    setBusy(name); setError('');
    try { await fn(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  async function takeControl() {
    await action('takeover', async () => {
      const result = await botApi<ComputerTakeover>(`${base}/takeover`, { method: 'POST', body: '{}' });
      setLeaseToken(result.leaseToken);
      sessionStorage.setItem(tokenKey, result.leaseToken);
      setStatus(result.status);
    });
  }

  async function releaseControl() {
    if (!leaseToken) return;
    await action('release', async () => {
      const result = await botApi<{ status: ComputerStatus }>(`${base}/release`, { method: 'POST', body: JSON.stringify({ leaseToken }) });
      sessionStorage.removeItem(tokenKey);
      setLeaseToken('');
      setStatus(result.status);
    });
  }

  if (!connected) return <div className="ab-computer-empty"><Monitor size={34} /><h3>Computer runtime is not connected</h3><p>This deployment has not enabled the Aira Bot computer provider.</p></div>;

  return <div className="ab-computer-panel">
    <div className="ab-computer-status">
      <div><span className={`ab-computer-dot ${status.state === 'RUNNING' ? 'is-running' : ''}`} /><strong>{status.state === 'RUNNING' ? 'Computer running' : 'Computer ready'}</strong><small>{status.provider?.isolation === 'docker-container' ? 'Docker-isolated persistent computer' : 'Bounded local computer'} · {status.workspaceReady ? 'workspace ready' : 'workspace creates on first use'}</small></div>
      <div className="ab-computer-actions">
        <button className="ab-icon-button" aria-label="Refresh computer" onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={15} /></button>
        {hasManualComputer && !status.humanControl && <button className="ab-primary" disabled={!!busy} onClick={() => void takeControl()}><Hand size={14} />Take control</button>}
        {hasOurControl && <button className="ab-secondary" disabled={!!busy} onClick={() => void releaseControl()}><Undo2 size={14} />Return control</button>}
      </div>
    </div>

    {status.lease && <div className="ab-policy-note"><Hand size={15} />{status.lease.mode === 'HUMAN' ? (hasOurControl ? 'You control this computer. Aira Bot waits at a safe checkpoint.' : 'This computer is under human control in another session.') : `Aira Bot is using this computer for ${status.lease.holderId.replace(/^run:/, 'run ')}.`}</div>}
    {controlledElsewhere && <p className="ab-muted">Return control from the session that acquired it, or let the takeover lease expire.</p>}
    {error && <p className="ab-error" role="alert">{error}</p>}

    <section className="ab-computer-section">
      <header><Globe size={16} /><div><strong>Browser</strong><small>Persistent session · public-network destinations only</small></div></header>
      {canBrowse ? <>
        <form className="ab-inline-form" onSubmit={event => { event.preventDefault(); void action('browser', async () => { const view = await botApi<BrowserView>(`${base}/browser/open`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ url: browserUrl }) }); setBrowserView(view); setStatus(await botApi<ComputerStatus>(base)); }); }}>
          <input type="url" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} required aria-label="Browser URL" />
          <button className="ab-primary" disabled={!!busy || !hasOurControl}>Open</button>
        </form>
        {(canClick || canType || canWait) && <div className="ab-browser-controls">
          <input value={browserSelector} onChange={event => setBrowserSelector(event.target.value)} placeholder="CSS selector, e.g. button[type=submit]" aria-label="Browser selector" />
          {canType && <input value={browserText} onChange={event => setBrowserText(event.target.value)} placeholder="Text to type" aria-label="Browser text" />}
          <div>
            {canClick && <button className="ab-secondary" disabled={!!busy || !hasOurControl || !browserSelector} onClick={() => void action('click', async () => setBrowserView(await botApi<BrowserView>(`${base}/browser/click`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ selector: browserSelector }) })))}><MousePointer2 size={13} />Click</button>}
            {canType && <button className="ab-secondary" disabled={!!busy || !hasOurControl || !browserSelector} onClick={() => void action('type', async () => setBrowserView(await botApi<BrowserView>(`${base}/browser/type`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ selector: browserSelector, text: browserText }) })))}>Type</button>}
            {canWait && <button className="ab-secondary" disabled={!!busy || !hasOurControl || !browserSelector} onClick={() => void action('wait', async () => setBrowserView(await botApi<BrowserView>(`${base}/browser/wait`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ selector: browserSelector }) })))}>Wait</button>}
            {canScroll && <button className="ab-secondary" disabled={!!busy || !hasOurControl} onClick={() => void action('scroll', async () => setBrowserView(await botApi<BrowserView>(`${base}/browser/scroll`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ deltaY: 700 }) })))}>Scroll</button>}
          </div>
        </div>}
        {browserView && <div className="ab-browser-view"><strong>{browserView.title || browserView.url}</strong><a href={browserView.url} target="_blank" rel="noreferrer">{browserView.url}</a><p>{browserView.text.slice(0, 1200) || 'No visible body text.'}</p><small>Viewport captured to {browserView.screenshotPath}</small></div>}
        {!hasOurControl && hasManualComputer && <p className="ab-muted">Take control before interacting with the browser manually.</p>}
      </> : <p className="ab-muted">Enable Browser in this bot’s capabilities.</p>}
    </section>

    <section className="ab-computer-section">
      <header><SquareTerminal size={16} /><div><strong>Terminal</strong><small>{status.provider?.isolation === 'docker-container' ? 'Runs inside the isolated container' : 'Direct allowlisted programs'} · no command shell</small></div></header>
      {canTerminal && status.terminal.enabled ? <>
        <form className="ab-terminal-form" onSubmit={event => { event.preventDefault(); void action('terminal', async () => { setTerminalResult(await botApi<TerminalResult>(`${base}/terminal`, { method: 'POST', headers: leaseHeaders, body: JSON.stringify({ program, args: argsText.split('\n').filter(Boolean) }) })); }); }}>
          <select value={program} onChange={event => setProgram(event.target.value)}>{status.terminal.allowedPrograms.map(item => <option key={item}>{item}</option>)}</select>
          <textarea rows={2} value={argsText} onChange={event => setArgsText(event.target.value)} placeholder="One argument per line" aria-label="Terminal arguments" />
          <button className="ab-primary" disabled={!!busy || !program || !hasOurControl}>Run</button>
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
            <div>{canWrite && <button className="ab-primary" disabled={!!busy || !filePath || !hasOurControl} onClick={() => void action('write', async () => { await botApi(`${base}/file`, { method: 'PUT', headers: leaseHeaders, body: JSON.stringify({ path: filePath, content: fileContent }) }); await refresh(); })}><Save size={14} />Save</button>}<button className="ab-secondary" onClick={() => { setFilePath('notes.md'); setFileContent(''); }}><FilePlus2 size={14} />New</button></div>
          </div>
        </div>
      </> : <p className="ab-muted">Enable workspace file read or write for this bot.</p>}
    </section>

    <section className="ab-computer-section">
      <header><Monitor size={16} /><div><strong>Live computer activity</strong><small>Current API-worker event stream</small></div></header>
      {events.length ? <ol className="ab-timeline">{events.slice(-12).reverse().map(event => <li key={event.sequence}><span className="ab-event-dot" /><strong>{event.type.replaceAll('.', ' ')}</strong><time>{new Date(event.timestamp).toLocaleTimeString()}</time></li>)}</ol> : <p className="ab-muted">Computer activity appears here as the bot or human operates it.</p>}
      <div className="ab-computer-actions">
        {canBrowse && status.browser.state === 'STOPPED' && <button className="ab-secondary" disabled={!!busy} onClick={() => void action('start', async () => { setStatus(await botApi<ComputerStatus>(`${base}/start`, { method: 'POST' })); })}><Play size={14} />Start computer</button>}
        {hasOurControl && status.browser.state === 'RUNNING' && <button className="ab-secondary" disabled={!!busy} onClick={() => void action('stop', async () => { setStatus(await botApi<ComputerStatus>(`${base}/stop`, { method: 'POST', headers: leaseHeaders })); })}><Power size={14} />Stop browser</button>}
      </div>
    </section>
  </div>;
}
