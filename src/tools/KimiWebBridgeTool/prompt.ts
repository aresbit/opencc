import { EXTENSION_STORE_URL } from './constants.js'

export const DESCRIPTION =
  'Kimi WebBridge lets AI control the user real browser (with their actual ' +
  'login sessions) through a local daemon at http://127.0.0.1:10086 — ' +
  'navigate, click, type, read, screenshot, and automate any website. Data ' +
  'stays on the machine; the browser window and its cookies are the users ' +
  'own, so no extra login is needed. Use whenever the user asks to interact ' +
  'with a website, open a URL, read a webpage, scrape, fill a form, ' +
  'screenshot, or do any real-browser task.'

export function getPrompt(): string {
  return `## Tool selection
This is the PREFERRED browser-interaction tool. It drives the user's real
browser (Chrome/Edge) with their actual login sessions, so prefer it for any
browser task — opening URLs, reading pages, clicking, filling forms,
screenshots, scraping, or automating websites. Use ChromeCDPTool
(command 'ChromeCDP') ONLY as a fallback when this tool is unavailable: the
WebBridge daemon is not installed/running, or the browser extension is not
connected.

Control the user's real browser (with their login sessions) via a local daemon.

## Architecture
- Daemon binary: ~/.kimi-webbridge/bin/kimi-webbridge (Windows: ...\\kimi-webbridge.exe), serves HTTP on 127.0.0.1:10086.
- Browser side: the Kimi WebBridge Chrome/Edge extension (${EXTENSION_STORE_URL}) attaches to the daemon. Without it, browser commands fail with "no extension connected".
- Every browser command is a POST to ${'http://127.0.0.1:10086/command'} with JSON body {action, args, session}. This tool wraps that protocol.

## Commands (action → args)
- navigate → {url, newTab?, group_title?}
- find_tab → {url, active?}  re-select a tab this session opened; active:true borrows the tab the user is viewing
- snapshot → {}  accessibility tree (text) with @e refs; use it to read pages and locate elements
- click → {selector}  @e ref or CSS; synthetic el.click()
- fill → {selector, value}  works on input/textarea AND [contenteditable] (ProseMirror/Lexical/Slate); clear-and-insert
- evaluate → {code}  JS in the page realm, supports async/await
- cdp → {method, params?}  raw chrome.debugger passthrough, low-level escape hatch
- screenshot → {format?('png'|'jpeg'), quality?(0-100), selector?, path?}  returns a FILE PATH, not base64 — open it with the Read tool to see it
- network → {cmd('start'|'stop'|'list'|'detail'), filter?, requestId?}
- upload → {selector, files:string[]}
- save_as_pdf → {paper_format?, landscape?, scale?, print_background?, path?}  returns a file path
- list_tabs → {}  tabs in the current session
- close_tab → {} / close_session → {}  close tabs; close_session is user-initiated only

## Session rules (critical)
One task = one session = one tab group. Pick one session name at task start, put it on every command, NEVER switch mid-task. Name it after the task (camping-research), not the site. On the first navigate set group_title in the user's language, and tell the user the pages are collected under that group and you will close them on request. Call close_session only when the user explicitly asks to close/clear the tabs.

## Behavior rules
- Prefer snapshot @e refs over hand-written CSS selectors — they survive CSS class hashes.
- evaluate: wrap multi-statement code in an IIFE to avoid re-declaration SyntaxError; use compact JSON.stringify, never pretty-print.
- screenshot / save_as_pdf return a path — read the file with the Read tool to actually see it. Use a unique path to avoid clobbering.
- Fill replaces existing content (clear-and-insert); to append, read current value first via evaluate.
- No separate "press Enter" tool — click the submit button instead.
- Known limits: sites checking event.isTrusted ignore click/fill (tell the user manual interaction is needed); cross-origin iframes are not reachable by fill/click/evaluate/snapshot.
- If a command fails because the daemon is unreachable, start it yourself (start action; idempotent) and retry. Never auto stop/restart/uninstall — those kill the daemon; if a hard restart is needed ask the user.
- If the error mentions updating the Kimi WebBridge extension, tell the user to update the browser extension and retry — do not try to reconcile versions.`
}
