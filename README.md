# LSY WX Relay

A small scheduled job that fetches **public weather model and forecast data for the coming seven days**
and publishes it as one compact JSON file. A weather map uses that file for an explicit "refresh
forecast" button, so the map can show a newer forecast than the one it was built with.

> **Not for operational use.** This is model and forecast data, reformatted and partly derived by this
> relay. It is not a flight-planning, dispatch or pilot-briefing product and not an official
> meteorological service. For operations use the approved sources (WAFC charts via SADIS/WIFS, SIGMETs,
> national meteorological services). Model-derived layers are labelled as such; days 4–7 are low confidence.

## How it works

```
GitHub Actions, 04:30, 10:30, 16:30 and 22:30 UTC (and on demand)
  relay.js ── public sources (list below) ──► out/latest.json ── privacy check ──►
  branch "data": one commit holding latest.json, force-pushed each run
  https://raw.githubusercontent.com/kwieser76/LSY_WX_Relay/data/latest.json
```

- `main` holds the code: `relay.js`, the fetchers and decoders in `scripts/` (Node 20, no
  dependencies), `config.json`, `privacy-check.js` and the workflow `.github/workflows/wx-relay.yml`.
- `data` holds only `latest.json`. Every run replaces the branch with a single new commit, so the
  repository does not grow and the URL always points at the newest file.
- A run that fails completely (every source failed, or the privacy check found something) publishes
  nothing; the previous `latest.json` stays. A single source that fails becomes `null` in the file, with
  the reason in `status`.
- Every request carries the User-Agent `LSY-WX-Relay/1.0 (+https://github.com/kwieser76/LSY_WX_Relay)`.
  A server that answers HTTP 403 or 429 is not asked again in that run. Hosts are paced as their
  operators ask (NOMADS: one request a second; AWC: well under 100 a minute).
- GitHub may start scheduled runs late, and disables scheduled workflows in public repositories after
  60 days without repository activity; re-enable it in the Actions tab if that happens.

## The file: `latest.json` (schema `lsy-wx-relay/1`)

| Field | Content |
|---|---|
| `schema` | `"lsy-wx-relay/1"` |
| `generatedAt` | when the run started (UTC) |
| `relayRun` | `{ id, url }` of the GitHub Actions run |
| `window` | `{ from, to }`: the 7 forecast days, today (UTC) to today + 6 |
| `parts.wxoutlook` | GFS jets and flight levels (tropopause, max wind, freezing level), convective potential (GFS and ECMWF), GFS vs ECMWF by day, SPC day 1–8 outlook areas, NHC/CPHC and JTWC tropical cyclones, WPC/CPC hazards, SWPC space weather |
| `parts.sigwx` | official WAFS SIGWX (FL100–600) of the newest run: the 12Z charts up to T+48 |
| `parts.sigwxModel` | model-derived SIGWX from GFS for the 7 days: jets and tropopause; CAT potential and CB to +72 h |
| `parts.gefscat` | ensemble CAT probability, days 3–7: the share of the 31 GEFS members whose Ellrod index shows CAT potential |
| `parts.dust` | dust optical depth classes from GEFS-Aerosols, 5 days |
| `status.<part>` | `{ ok, error?, seconds, requests, megabytes, hosts }` |
| `attribution` | the credit lines below; show them with the data |
| `disclaimer` | the "not for operational use" text |

Each part keeps its own model run, issue and valid times, label, attribution and notes. Grids are
base64 or run-length encoded as described inside each part. There are no airport-specific values in this
file.

## Sources and licences

| Source | Used for | Licence / terms |
|---|---|---|
| NOAA GFS 1° and 0.5° (NOMADS grib filter; NOAA open data on AWS as fallback) | jets, flight levels, convective potential, model-derived SIGWX | public domain ([weather.gov/disclaimer](https://www.weather.gov/disclaimer)) |
| NOAA GEFS v12 0.5° (NOAA open data on AWS) | ensemble CAT probability | public domain |
| NOAA GEFS-Aerosols (NOAA open data on AWS) | dust | public domain |
| ECMWF IFS HRES open data ([data.ecmwf.int](https://data.ecmwf.int/forecasts)) | 250 hPa wind for the model comparison, convective potential | CC BY 4.0 — "Contains ECMWF Open Data"; values derived (modified) by this relay |
| NOAA SPC, NHC/CPHC, WPC, CPC (api.weather.gov), SWPC | outlooks, tropical cyclones, space weather | public domain |
| US Navy JTWC (RSS and warning texts) | tropical cyclones, West Pacific / Indian Ocean / Southern Hemisphere | US Government work |
| NOAA/NWS Aviation Weather Center, WAFS SIGWX GeoJSON | official SIGWX, up to T+48 | the files name no issuing centre; clipped and simplified here, not an official chart |

Credit lines carried in the file:

- Contains ECMWF Open Data (CC BY 4.0): based on data and products of the European Centre for
  Medium-Range Weather Forecasts (ECMWF), www.ecmwf.int; values derived (modified) by this relay. ECMWF
  accepts no liability for errors or omissions.
- NOAA/NWS data: public domain. Reformatted and derived by this relay; not an official NOAA/NWS product,
  not endorsed by NOAA.

## Run it yourself

```
node relay.js --out out                # a few minutes, about 800 requests and 230 MB download
node privacy-check.js out/latest.json  # exit 1 on a finding
```

Options: `--parts wxoutlook,dust` (a subset), `--deny-file FILE` (hosts never to contact, first field of
each line; a 403/429 is appended), `--allow-host HOST`.
