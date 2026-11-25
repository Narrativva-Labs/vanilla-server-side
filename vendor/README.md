# Připnutá knihovna 0.7.3

Služba i Vanilla používají totožný archiv `visitor-verdict-server-0.7.3.tgz`, jednou vytvořený přes `npm pack --offline` z worktree ip-mismatch (základ 2715bbd + opravy K5). Balíček se po zabalení neupravuje. Starší archivy jsou historické.

SHA-512:

```
5202fa6e4ac94e291c439938f6ecd1eef61d69e878674d0179ced6002fa287ffdfead4bdd59989522deef3050fefc950c5c678d07a6d42196842fd0590255190
```

K5: krátké retry a poctivý warm/status pro SAIL shrink, odebrání neúplné služby bez falešného shrink, validace ne-listového ne-WBA, pevný marker místo syrového neřetězcového Signature-Agent. CONTRACT.md je bajtově shodný se službou. Manifesty a lockfily vybírají 0.7.3.
