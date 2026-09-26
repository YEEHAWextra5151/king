# Security

Everything below is hostile HTML. Folio must render it inert.

<script>window.__pwned = "script"</script>

<img src="missing.png" onerror="window.__pwned = 'onerror'" alt="broken">

<a href="javascript:window.__pwned='href'">javascript link</a>

[markdown javascript link](javascript:alert(1))

<iframe src="https://example.com/frame"></iframe>

<form action="https://example.com/collect"><input name="q"><button>Send</button></form>

<p align="center" style="color: red" onclick="window.__pwned = 'click'">Centered paragraph</p>

<details><summary>Summary</summary>Inside the details.</details>

Press <kbd>⌘</kbd> <kbd>K</kbd>; water is H<sub>2</sub>O and x<sup>2</sup> is a square.

<picture><source srcset="docs/images/layout.svg" media="(prefers-color-scheme: dark)"><img src="docs/images/layout.svg" width="160" alt="Picture"></picture>

<svg onload="window.__pwned = 'svg'"><circle r="5"></circle></svg>

<object data="movie.swf"></object><embed src="movie.swf">

<meta http-equiv="refresh" content="0; url=https://example.com/">

<base href="https://example.com/">

<style>body { display: none !important; }</style>

<a href="vscode://file/etc/hosts">custom scheme link</a>

<a href="https://example.com/" target="_blank">new window link</a>

<div id="clobber" name="getElementById">DOM clobbering attempt</div>
