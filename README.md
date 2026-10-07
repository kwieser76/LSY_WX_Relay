# LSY WX Relay

A small scheduled job that fetches **public weather model and forecast data for the coming seven days**,
**today's North Atlantic track message** and **the observed weather of the current week so far** (US
convective SIGMETs, US storm reports, satellite lightning over Europe and the Middle East, US radar storm
hours) and publishes it as one compact JSON file. A weather map uses that file for an explicit "refresh"
button, so the map can show newer data than it was built with.

> **Not for operational use.** This is model and forecast data, reformatted and partly derived by this
> relay. It is not a flight-planning, dispatch or pilot-briefing product and not an official
> meteorological service. For operations use the approved sources (WAFC charts via SADIS/WIFS, SIGMETs,
> national meteorological services). Model-derived layers are labelled as such; days 4–7 are low confidence.
> The observed weather is sampled and reduced (hours per 0.5° cell), and the track message is a copy for
> orientation only.

## How it works

```
GitHub Actions, 04:30, 10:30, 16:30 and 22:30 UTC (and on demand)
  branch "data" ──► cache/ (hours already read this week)
  relay.js ── public sources (list below) ──► out/latest.json + out/cache/ ── privacy check ──►
  branch "data": one commit holding latest.json and cache/, force-pushed each run
  https://raw.githubusercontent.com/kwieser76/LSY_WX_Relay/data/latest.json
```

- `main` holds the code: `relay.js`, the fetchers and decoders in `scripts/` (Node 20, no
  dependencies), `config.json`, `privacy-check.js` and the workflow `.github/workflows/wx-relay.yml`.
- `data` holds `latest.json` and `cache/lightning-<week>.json`, `cache/mrms-<week>.json`. Every run
  replaces the branch with a single new commit, so the repository does not grow and the URL always points
  at the newest file. The caches hold the lightning frames and radar hours of the current ISO week that
  earlier runs already read (reduced to 0.5° cells), so a run downloads only the new hours; they are
  dropped when the week changes, and a missing or broken cache only means that run starts fresh.
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
| `parts.nat` | today's North Atlantic track message: `{ fetchedAt, page, sets }`, one set per direction with its tracks (route, entry, latitude at 30/40/50W), TMI, split and remarks |
| `parts.since` | the observed weather of the current ISO week, Monday 00Z to the run: `{ window {from, to, asOf, week}, wxreview, lightning, mrms }` (each null when it failed) |
| `parts.since.wxreview` | US convective SIGMETs (counts, and a 1° grid over North America of how often a cell lay inside one at the 3-hourly sample moments) and SPC storm reports (per day and as points). Nothing else: no international SIGMETs, no pilot reports, no airport observations |
| `parts.since.lightning` | EUMETSAT MTG Lightning Imager: per day and 0.5° cell the hours whose sampled frame (one 5-minute frame per hour) showed lightning, Europe/North Atlantic and the Middle East |
| `parts.since.mrms` | NOAA MRMS: per day and 0.5° cell the hours with radar reflectivity ≥ 40 dBZ, and the day's radar-estimated hail, US |
| `status.<part>` | `{ ok, error?, seconds, requests, megabytes, hosts }`; the since sub-parts as `status["since.lightning"]` etc., with `cache { reused, fetched }` |
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
| FAA NOTAM System, North Atlantic track message ([nms.aim.faa.gov/nat](https://nms.aim.faa.gov/nat)) | today's NAT tracks | US Government work (public domain); tracks issued by Shanwick and Gander |
| Iowa Environmental Mesonet (Iowa State University), SIGMET archive | US convective SIGMETs of the week | public domain ([disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php)); the SIGMETs are NOAA/NWS products |
| NOAA SPC storm reports ([spc.noaa.gov/climo](https://www.spc.noaa.gov/climo/online/)) | tornado, wind and hail reports of the week (preliminary) | public domain |
| EUMETSAT MTG Lightning Imager, accumulated flash area via EUMETView WMS ([view.eumetsat.int](https://view.eumetsat.int/)) | lightning hours of the week | CC BY 4.0 under the EUMETSAT Data Policy — "Contains modified EUMETSAT Meteosat product <year>" |
| NOAA MRMS on the NOAA Open Data Dissemination program (noaa-mrms-pds on AWS) | radar storm hours and hail of the week | NOAA open data, attribution requested; modified data, not original NOAA data |

Credit lines carried in the file:

- Contains ECMWF Open Data (CC BY 4.0): based on data and products of the European Centre for
  Medium-Range Weather Forecasts (ECMWF), www.ecmwf.int; values derived (modified) by this relay. ECMWF
  accepts no liability for errors or omissions.
- NOAA/NWS data: public domain. Reformatted and derived by this relay; not an official NOAA/NWS product,
  not endorsed by NOAA.
- Contains modified EUMETSAT Meteosat product <year> (CC BY 4.0): MTG Lightning Imager accumulated flash
  area, one frame per hour reduced to hours with lightning per 0.5° cell by this relay. The year is the one
  in the file's credit line; show it wherever the lightning layer is shown.
- NOAA MRMS radar data via the NOAA Open Data Dissemination program: modified — reduced by this relay to
  hours ≥ 40 dBZ and daily radar-estimated hail per 0.5° cell; not original NOAA data.
- US convective SIGMETs via the Iowa Environmental Mesonet SIGMET archive; SPC storm reports (preliminary).
- North Atlantic track message: FAA NOTAM System.

## Run it yourself

```
node relay.js --out out --cache out/cache          # a few minutes; see below for the download
node privacy-check.js out/latest.json out/cache    # exit 1 on a finding
```

Options: `--parts wxoutlook,dust,nat,since` (a subset), `--cache DIR` (the caches of the previous run;
without it the observed week starts fresh), `--deny-file FILE` (hosts never to contact, first field of each
line; a 403/429 is appended), `--allow-host HOST`.

Download per run: the week ahead about 800 requests and 230 MB. The observed week depends on the cache: a
run with the previous run's cache reads only the hours since then (a few lightning frames and radar files,
about 20 MB); a run without one reads the whole week so far, capped at 170 lightning frames and 110 radar
files (about 280 MB) per run — the next run fills the rest.
