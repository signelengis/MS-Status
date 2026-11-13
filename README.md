# Microsoft services status

A status board for Microsoft cloud services, hosted on GitHub Pages. It answers one
question quickly: is the problem ours, or Microsoft's?

Every 10 minutes a GitHub Actions job:

1. reads the public status feeds for **Azure** (RSS), **Azure DevOps** (Status API) and **GitHub** (Statuspage API);
2. runs **web checks** against the URLs in `config/checks.json` (Microsoft 365 sign-in, Outlook, Teams, Graph, the Azure portal, county sites), recording HTTP status, response time and days until the TLS certificate expires;
3. marks **Azure regions** named in active public incidents;
4. publishes the static site plus `data/status.json` and `data/history.json` (a rolling 24 hours) to GitHub Pages.

Nothing is committed on each run. History carries over by reading the previous
`history.json` back from the live site.

## What it can and can't see

- **Public sources only.** Microsoft's public Azure page only covers incidents with broad impact; most issues are sent privately through Azure Service Health. Microsoft 365 has no public machine-readable feed, so Microsoft 365 status here comes from the web checks. Tenant-specific health (Microsoft 365 admin center, Azure Service Health, Resource Health) needs credentials and isn't read.
- **Internet-facing URLs only.** Checks run from GitHub's cloud runners, so internal hostnames and private IPs can't be reached. Don't put internal hostnames in `config/checks.json`, because this repository and site may be public.
- **Region status is inferred** by matching region names (for example "East US 2") in incident text. Edit `config/azure-regions.json` to add regions as Microsoft opens them, or add `aliases`.

## Set up

1. Create a repository on GitHub and push this folder to its `main` branch.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open the **Actions** tab, choose **Collect status**, and click **Run workflow** once. After that it runs every 10 minutes on its own.
4. The site appears at `https://<owner>.github.io/<repo>/`.

Notes:

- GitHub Pages sites are public unless the account is on GitHub Enterprise Cloud. Everything on this board comes from public sources, so that's fine as long as no internal URLs are added.
- GitHub can start scheduled runs a few minutes late, and it pauses scheduled workflows in public repositories after 60 days without repository activity. The page warns when its data is more than about 35 minutes old.
- Scheduled runs use Actions minutes. Public repositories don't pay for these; private ones draw on the account's included minutes.

## Change what's checked

Edit `config/checks.json`. Each check takes:

| field | meaning |
| --- | --- |
| `name` | label on the board |
| `url` | address to request (GET, redirects are not followed) |
| `okStatus` | optional list of HTTP codes that count as up, e.g. `[200, 401]` for an API that requires sign-in. Without it, any 2xx or 3xx counts as up |
| `enabled` | `false` to keep a check in the file without running it |
| `timeoutMs`, `checkCert` | optional per-check overrides |

`defaults.slowMs` (3000) is the response time above which a check shows as slow, and
`defaults.certWarnDays` (14) is when an expiring certificate starts showing as a notice.

To check SharePoint, replace `YOUR-TENANT` in the SharePoint entry and set `enabled` to `true`.

## Run it locally

Needs Node 20 or later, no packages.

```sh
node test/run.mjs            # offline tests + 24 h of simulated demo data in site/data/
node test/run.mjs calm       # same, with everything healthy
cd site && python3 -m http.server 8000   # then open http://localhost:8000
node scripts/collect.mjs     # a real run (needs internet)
```

The board opens in dark mode. The **Light mode / Dark mode** button in the top corner switches it, and each browser remembers its choice. Adding `?theme=dark` or `?theme=light` to the URL overrides that, which is handy for a wall display.

## Files

```
config/checks.json         web checks and thresholds
config/azure-regions.json  Azure regions, grouped by geography
scripts/collect.mjs        the collector (Node, no dependencies)
scripts/lib/               feed parsers and the HTTP/TLS check
site/                      the dashboard (plain HTML, CSS, JS)
test/                      offline tests and fixture data
.github/workflows/         the scheduled collect-and-publish job
```
