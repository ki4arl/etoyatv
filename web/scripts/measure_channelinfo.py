#!/usr/bin/env python3
"""Measure .channelinfoblock description grid placement locally (headless CDP)."""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

NAME = "etoya-chrome-measure"
URL = sys.argv[1] if len(sys.argv) > 1 else "https://localhost/ntvmir"


def main():
    subprocess.run(
        ["docker", "rm", "-f", NAME],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    r = subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--network",
            "host",
            "--name",
            NAME,
            "zenika/alpine-chrome:124",
            "--no-sandbox",
            "--disable-gpu",
            "--headless=new",
            "--remote-debugging-port=9222",
            "--remote-allow-origins=*",
            "about:blank",
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print("start failed", r.stderr, file=sys.stderr)
        sys.exit(1)

    tabs = None
    for _ in range(30):
        try:
            tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=2))
            if tabs:
                break
        except Exception:
            time.sleep(0.3)
    if not tabs:
        print("no cdp", file=sys.stderr)
        subprocess.run(["docker", "rm", "-f", NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(1)

    ws = websocket.create_connection(tabs[0]["webSocketDebuggerUrl"], timeout=30)
    msg_id = 0

    def call(method, params=None, timeout=60):
        nonlocal msg_id
        msg_id += 1
        mid = msg_id
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            data = json.loads(ws.recv())
            if data.get("id") == mid:
                return data
        raise TimeoutError(method)

    call("Page.enable")
    call("Page.navigate", {"url": URL})
    call(
        "Runtime.evaluate",
        {
            "expression": (
                'new Promise(r => { if (document.readyState==="complete") r(1);'
                " else window.addEventListener(\"load\",()=>r(1)); })"
            ),
            "awaitPromise": True,
        },
    )
    time.sleep(1.2)

    expr = """(() => {
  const block = document.querySelector('.right_blocks .channelinfoblock');
  if (!block) return {error: 'no block', htmlSnippet: document.body.innerHTML.slice(0,200)};
  const desc = block.querySelector('.description');
  const left = block.querySelector('.left');
  const title = block.querySelector('h1.title');
  const wrap = block.querySelector(':scope > div');
  const right = block.querySelector('.right');
  const cs = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      className: el.className,
      display: s.display,
      gridArea: s.gridArea,
      gridColumn: s.gridColumn,
      gridRow: s.gridRow,
      width: s.width,
      float: s.float,
      rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}
    };
  };
  return {
    bodyTheme: document.body.className,
    scheme: document.documentElement.getAttribute('data-scheme'),
    blockDisplay: getComputedStyle(block).display,
    blockGridTemplate: getComputedStyle(block).gridTemplateColumns,
    hasDirectLeft: !!block.querySelector(':scope > .left'),
    wrap: cs(wrap),
    left: cs(left),
    right: cs(right),
    title: cs(title),
    description: cs(desc),
  };
})()"""

    res = call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    value = (res.get("result") or {}).get("result", {})
    if value.get("type") == "object" and "value" in value:
        out = value["value"]
    else:
        out = value
    print(json.dumps(out, ensure_ascii=False, indent=2))
    ws.close()
    subprocess.run(["docker", "rm", "-f", NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
