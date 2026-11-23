# Opravy expertní oponentury Vanilly

Větev `audit-fixes-vanilla`, včetně B7. Bez commitu a bez změn `.git`.

Opraveno (nálezy potvrzené čtením kódu a reprodukcemi/regresními testy):

1. Zjevné boty výchozí režim označí a předá Googlu. UA doplňuje důkaz automatizace; ověřenou identitu ani neplatný podpis nepřebíjí. `FILTER_OBVIOUS_BOTS=off` výchozí, `on` obnoví původní filtr. Přidán `botsLabelled`, `botsFiltered` ponechán pro tento opt-in filtr.
2. Odchod dokumentu synchronně předá transportu čekající konverze i aktualizace třídy vedle již běžícího požadavku. Bootstrap tajemství zůstává společné; integrační unit test ověřuje jediného klienta/session a jediné otevření session. Probíhající požadavek se neposílá podruhé.
3. Retry po Google 5xx používá původní verdikt pouze pro shodný otisk události, payloadu, peer IP, metody, URL a hlaviček. Paměť má kapacitu 10 000 a TTL 60 s. Skutečný verifier s lokální podpisovou fixture: 503 → retry zachová `agent_verified`; jiné event_id se stejným podpisem dostane `bot_spoofed`.
4. Fáze final/agent mají společný dokumentový limit napříč `/d` a `/e` (max. dvě aktualizace).
5. `/d` před rekurzivními filtry používá `jsonSnapshot` jako `/e`; příliš hluboké params vracejí 400.
6. Nad 16 KiB se krátí poslední položky; `vv_type` i `vv_detail` zůstávají. Nezkrátitelný nadlimitní payload bez položek může stále narazit na limit transportu.
7. Aktualizace třídy uvolněná po čekání na souhlas nepodléhá 30s limitu běžné fronty; zachovává timestamp a obecný limit stáří události. Ověřeno po minutě čekání.
8. `KEEP_QUERY_PARAMS` je seznam dalších zachovaných query názvů, výchozí prázdný. `vvp` prochází klientem i oběma cestami kolektoru. Výchozí čištění URL zůstává jen `utm_*`, reklamní ID se dále redigují.

Dodatečné rozhodnutí Františka k `/d` je zapracováno: pevný allowlist na klientu i serveru (název události, URL/referrer, value, currency a známá pole Visitor Verdict). Vlastní parametry, items, transaction_id a user_data se nepřenášejí. Claim na dedikované aktualizaci má pevný slovník, včetně dom_host. Regrese prokazuje odstranění e-mailu z vlastních skalárních i vnořených polí a položek, i při přímém POST obcházejícím klienta. Titulek zůstává kontextem; IP, UA a výchozí `DENIED_PING_IP=full` / `DENIED_PING_USER_AGENT=on` beze změny. Popsáno v README, INSTALL, CHANGELOG a `.env.example`.

Původně odložený návrh allowlistu pingu nahradilo výše uvedené výslovné rozhodnutí; není zde další neprovedená změna rozsahu pingu. Žádný ze zadaných nálezů nebyl vyhodnocen jako neplatný. Související SQL, GTM, sGTM ani jiné repozitáře nejsou součástí této opravy. Skutečný zánik dokumentu a limity browserového keepalive bez e2e neověřeny.

Kontroly CI (lokální Node 22.23.4; CI používá Node 26):

- `format:check`, `typecheck`, `build`, `git diff --check`: prošly.
- `npm test`: **620/624 prošlo**, 44/47 souborů; zbývající čtyři testy v scripts, path-proxy a ping-privacy selhaly kvůli sandboxovému `listen EPERM 127.0.0.1` (navíc 1 unhandled error). Nejde o zelený plný běh.
- Samostatný běh bez těchto tří souborů: **602/602 prošlo**, 44/44 souborů. B7 regrese jsou zahrnuty.
- `bash -n install.sh update.sh`: prošlo. Compose konfigurace s dočasnou kopií `.env.example` prošla přes dostupný `docker-compose`; pracovní `.env` nevznikl.
- `shellcheck`: nástroj chybí. Docker build: sandbox odmítá přístup k Docker socketu. `npm ci` bez sítě neprováděno; použity existující závislosti. Instalace do čistého Linux VM a hostované CodeQL zde neproveditelné. Playwright/e2e dle zadání nespouštěny; verze lockfile 1.65.0 odpovídá CI image.

Návrh commit message: `Fix event delivery, bot labelling and denied ping parameter handling`
