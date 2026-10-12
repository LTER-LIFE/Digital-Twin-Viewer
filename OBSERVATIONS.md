# Field observations in the Digital Twin Viewer

Observations (station records, sampling campaigns, casts and surveys) are loaded
once into an **observation store** and from then on appear beside every model run
that overlaps them in space and time. The viewer works out what each collection
*is* from its sampling, and shows it where that kind of data belongs:

| What the data are | Examples | Shown as |
|---|---|---|
| **Time series** at fixed stations | NIOZ jetty T/S, RWS tide gauges, wave buoys, MWTL water quality | station marker; measured series on the timeseries chart; skill per station |
| **Time series of profiles** (depth-resolved, repeated) | moorings, thermistor chains, multi-depth sampling | as above, plus the nearest visit on the Vertical panel |
| **Profiles** (one-off casts) | ICES CTD casts | diamond on the map near its time; dashed profile on the Vertical panel |
| **Spatial survey** (many stations, each visited rarely) | SIBES, MWTL benthos | dots on the map coloured by value; scatter against the model |
| **Moving platform** | FerryBox, ship underway | dots on the map |

Nothing is fetched at run time and nothing is tied to one model run: a
collection loaded today is picked up by every dataset over the same area.

---

## Contents

1. [Quick start](#1-quick-start)
2. [The file format](#2-the-file-format)
3. [The JSON sidecar](#3-the-json-sidecar)
4. [CF-1.8 NetCDF input](#4-cf-18-netcdf-input)
5. [How a collection is classified](#5-how-a-collection-is-classified)
6. [How observations are compared with the model](#6-how-observations-are-compared-with-the-model)
7. [Variable names and units](#7-variable-names-and-units)
8. [Worked examples](#8-worked-examples)
9. [The store, the tools, and the limits](#9-the-store-the-tools-and-the-limits)

---

## 1. Quick start

Prepare **one CSV** (the data) and, next to it, **one JSON sidecar** with the
same name (what the data mean). Then either

- in the viewer: **Observations** section (rail icon 7) → **⊕ Load observations…**,
  select both files; or
- from a shell, in the repository root:

```powershell
python obs_ingest.py check  my_data.csv --meta my_data.json   # dry run: the report only
python obs_ingest.py add    my_data.csv --meta my_data.json   # into data/observations/
python obs_ingest.py list                                     # what is in the store
python obs_ingest.py remove my-data                           # take it out again
```

The report printed by `check` / `add` (and shown in the viewer after an upload)
says what was understood: how the collection was classified, which variables
were recognised and how their units convert, what was dropped and why. Read it:
anything the ingest had to assume is listed there as a WARNING.

A minimal pair:

`jetty.csv`
```csv
time,temp,sal
2015-01-01T01:00:00Z,3.64,28.13
2015-01-01T02:00:00Z,3.27,27.24
```

`jetty.json`
```json
{
  "format": "dtv-observations/1",
  "title": "NIOZ jetty: hourly temperature and salinity",
  "stations": {"NIOZ-JETTY": {"name": "NIOZ jetty (Texel)", "lat": 53.002, "lon": 4.789}},
  "variables": {
    "temp": {"units": "degC"},
    "sal":  {"units": "PSU"}
  }
}
```

---

## 2. The file format

A **CSV** file: comma, semicolon, tab or pipe separated (detected automatically),
UTF-8, optionally gzipped (`.csv.gz`). Leading lines starting with `#` are comments; `# key: value`
lines among them are read as metadata (e.g. `# title: …`), with the sidecar taking
precedence.

One row is one **sampling event** (a time, a place, optionally a depth). Two
layouts are accepted, and recognised automatically:

**Wide**: one column per variable. Best for instrument records and sample tables.

```csv
station,time,lat,lon,depth,temp,sal,chla
MARSDND,2015-03-10T10:25:00Z,52.9825,4.7499,1.0,4.7,28.4,4.78
```

**Long**: one row per value, with `variable` and `value` columns. Best for
database exports (Waterinfo, DONAR, ODV), where each row is one measurement and
units, flags and detection limits are per value.

```csv
station,time,lat,lon,depth,variable,value,units,qualifier,flag
MARSDND,2015-03-10T10:25:00Z,52.9825,4.7499,1.0,NO3,42.1,umol/l,,0
MARSDND,2015-03-10T10:25:00Z,52.9825,4.7499,1.0,CHLFa,0.5,ug/l,<,0
```

### Reserved columns

Column names are matched loosely (case, spaces, `_` and `-` are ignored), so
`Sample Depth`, `sample_depth_m` and `sampledepth` all mean `depth`. Any column
can be renamed to a reserved name with the sidecar's `columns` map.

| Column | Required | Meaning |
|---|---|---|
| `time` | yes | ISO 8601: `2015-07-14T10:25:00Z`, `2015-07-14 10:25+01:00`, or a date `2015-07-14`. Anything else needs `time_format` in the sidecar. Aliases: `datetime`, `timestamp`, `tijdstip`. |
| `date` + `clock` | instead of `time` | a date column and a separate time-of-day column, combined |
| `lat`, `lon` | yes¹ | decimal degrees, WGS84 (ETRS89 is the same at this scale) |
| `x`, `y` | instead of lat/lon | projected coordinates; give `crs` in the sidecar. RD New (EPSG:28992) and UTM (EPSG:258xx / 326xx) work out of the box, anything else with `pyproj` installed |
| `wkt` / `geom` | instead of lat/lon | `POINT (lon lat)` |
| `station` | no | station identifier. Without it, rows at the same position are one station |
| `station_name` | no | a readable name; otherwise the identifier is shown |
| **one** vertical column | no | see below |
| `variable`, `value` | long layout | the variable's name and its value |
| `units` | long layout, optional | units of that value (per row) |
| `flag` | optional | quality flag of that value (see *Quality flags*) |
| `qualifier` | optional | `<` below a detection limit, `>` above a range |

¹ Not needed in the file when the sidecar's `stations` table gives each station's
position, which is the usual case for a single fixed station.

Wide-layout extras: a column named `<variable>_qc`, `_flag` or `_quality` is that
variable's quality flag. Columns ending `_std`, `_n`, `_count`, `_src`, `_interval…`,
`_provider_flag` are treated as auxiliary and skipped, unless the sidecar's
`variables` block lists them; in that case **only** the listed columns are read.

Values: a decimal point, or a decimal comma when the file is `;`-separated (or the
sidecar says `"decimal": ","`). Empty, `NA`, `NaN`, `-999`, `-9999` are missing.
A value written `<0.05` is kept as *below detection limit* (see §6).

### The vertical position

Each measurement may carry **one** kind of vertical coordinate, chosen by the
column name. It decides where the value is placed against the model column:

| Column | Meaning | Placed against the model at |
|---|---|---|
| `depth` | metres **below the water surface**, positive down | model surface at that cell and hour − depth |
| `height_above_bed` | metres **above the sea bed**, positive up | model bed + height |
| `elevation` | metres relative to a stated datum (`vertical_datum`), positive up | that elevation, with the datum stated |
| `sediment_depth` | metres **below the sediment surface** | not in the water column (a bed property) |

Heights given in cm, or as a negative height below the surface (RWS
*bemonsteringshoogte* `-100` = 1 m deep), are converted with `vertical_units` and
`vertical_positive` in the sidecar. A sensor at a fixed depth that the file does
not repeat on every row is given once in the station table
(`"elevation": -1.5` for the jetty sensors at −1.5 m NAP).

**No vertical column** means the values are not depth-resolved. Say what they
represent with each variable's `level` (`surface`, `bottom`, `depth_mean`, `bed`,
`air`); the report and the readout carry it.

### Time

- Times with an offset (`Z`, `+01:00`) are exact. Times **without** one are taken
  in the sidecar's `time_zone` (`UTC`, `+01:00`, or `Europe/Amsterdam`); if it is
  not given, UTC is assumed and the report warns.
- A **date without a time of day** is placed at 12:00 UTC of that day, flagged as
  day-precision, and compared with the model at that time (for a survey on a dry
  flat, at the nearest wet step within a day; see §6).
- Non-ISO spellings (`7/14/2008`, `14-07-2008 10:25`) need `time_format`, a Python
  `strptime` pattern (`"%m/%d/%Y"`). The ingest never guesses day/month order.

### Quality flags

Flags are only applied when the sidecar says what they mean:

```json
"flags": {"good": [0, 1]}         // keep values flagged 0 or 1, drop the rest
"flags": {"bad":  ["25", "99"]}   // drop these, keep everything else
```

A file with flags but no convention keeps every value and the report warns that
the flags were *not* applied. Conventions differ (SeaDataNet: 1 = good; RWS
*kwaliteitswaardecode*: 00 = good; TESO: 0 = use), and guessing would silently
discard good data or keep bad data.

---

## 3. The JSON sidecar

Every key is optional except `format`; keys not listed here are ignored.

```jsonc
{
  "format": "dtv-observations/1",

  // identity and credit: shown in the viewer and written into exports
  "id": "rws-mwtl-marsdiep-noord",      // store name; default: the file name
  "title": "RWS MWTL: Marsdiep Noord water quality",
  "description": "…",
  "source": "Rijkswaterstaat (MWTL)",
  "citation": "…", "license": "CC0-1.0", "url": "…",
  "color": "#CC79A7",                   // marker colour; default: next Okabe–Ito colour

  // reading the file
  "columns": {"sample_depth_m": "depth", "parameter_code": "variable"},  // rename map
  "ignore": ["SampleID"],               // columns (or long-format variables) to skip
  "delimiter": ";", "decimal": ",",     // only when detection gets it wrong
  "time_format": "%m/%d/%Y %H:%M",      // strptime pattern for non-ISO times
  "time_zone": "UTC",                   // for times without an offset
  "time_range": ["2015-01-01", "2015-12-31T23:59:59"],   // keep only this window
  "crs": "EPSG:28992",                  // for x/y columns
  "vertical_units": "cm",               // m (default), dm, cm, mm
  "vertical_positive": "up",            // when the column's sign is the other way round
  "vertical_datum": "NAP",              // for an elevation column
  "flags": {"good": [0]},               // see Quality flags
  "default_station": "JETTY",           // rows with no station and no position

  // stations: positions, names, a fixed vertical position
  "stations": {
    "NIOZ-JETTY": {"name": "NIOZ jetty (Texel)", "lat": 53.002, "lon": 4.789, "elevation": -1.5}
  },

  // variables: when present, ONLY these are read
  "variables": {
    "temp": {
      "units": "degC",                  // required unless the header says 'temp [degC]'
      "long_name": "Water temperature",
      "quantity": "sea_water_temperature",   // optional: see §7
      "standard_name": "sea_water_temperature",
      "model": ["temp"],                // optional: force a match to these model keys
      "level": "surface",               // surface | bottom | depth_mean | bed | air
      "datum": "NAP"                    // for a level / elevation variable
    }
  },

  // comparison settings
  "comparison": {"window_days": 60}     // survey / profile time window on the map
}
```

Units may also be written in the CSV header, as in `temp [degC]` or `sal (PSU)`,
which saves a sidecar for the simplest files.

---

## 4. CF-1.8 NetCDF input

A NetCDF that follows the CF *discrete sampling geometries* conventions
(`featureType` = `timeSeries`, `point`, `profile`, `trajectory`) is read directly;
the RWS wave dataset built for this project is an example. What is understood:

- coordinates by `standard_name` / `axis` (`time`, `latitude`, `longitude`, and a
  vertical coordinate with its `positive` attribute);
- the instance id (`cf_role`) and a station-name variable beside it;
- orthogonal and incomplete multidimensional arrays, and contiguous ragged arrays;
- quality: CF `ancillary_variables` flags, a `valid_<name>` mask (1 = valid) when one
  exists, or a sidecar `"quality": {"hm0": {"mask": "valid_hm0", "good": [1]}}`;
- variables named `qc_*`, `valid_*`, `src_*`, `flag_*`, flag variables and integer
  variables are not measurements and are skipped.

Select variables and a time window from the command line or the sidecar:

```powershell
python obs_ingest.py add rws_wadden_waves.nc --meta rws_wadden_waves.json `
    --vars hm0,tm02,wl --from 2015-01-01 --to 2015-12-31T23:59:59
```

A sidecar for a NetCDF only adds what the file does not say (`include`,
`time_range`, `datum`, nicer `long_name`s); units and coordinates come from the file.

---

## 5. How a collection is classified

Files label themselves inconsistently, so the class is decided from the data. For
each station, the records are grouped into **visits**: what one deployment samples
in one go. Records at the same timestamp are one visit; otherwise a new visit
starts after 30 minutes, or as soon as a depth repeats (a CTD cast stamps each
level seconds apart but never returns to a depth; a continuous record at one
depth returns to it every sample). Then:

| Station | Rule |
|---|---|
| **profile** | a visit samples ≥ 3 distinct depths, and visits are one-off or > 7 days apart |
| **timeseries_profile** | depth-resolved visits ≤ 7 days apart (a mooring) |
| **timeseries** | repeated visits at one place |
| **point** | a single visit |
| **trajectory** | visits at different places (> ~500 m apart) |

A station whose visits fall on **at most three places, each visited at least
twice**, was relocated rather than carried about: Rijkswaterstaat moved several
MWTL stations by kilometres over the decades. Each position becomes a fixed station
of its own (the longest-used keeps the id, and the others are named after their
years, as in `BOCHTVWTM@2011-2021`), so each is compared at its own model cell, and
the ingest notes say what was split.

Cadence (median spacing of visits): **continuous** ≤ 3 h, **discrete** ≤ 45 days,
**sparse** beyond.

A collection is a **survey** when it has ≥ 20 stations and the typical station is
visited ≤ 4 times a year: SIBES's 4 000 stations, revisited every summer, are a map,
not 4 000 time series. Otherwise it takes the class most of its stations have. The
thresholds are constants at the top of `obs_ingest.py`.

---

## 6. How observations are compared with the model

Two rules run through everything, as they did for the CTD profiles:

**The model is brought to the observation, never the reverse.** Model values are
interpolated in time to the observation, and in depth onto the observed depths. A
measurement is never resampled, smoothed or gap-filled to suit the grid.

**What cannot be compared is not compared.** A unit that does not convert, a
different element (`g AFDM/m2` against `mg C/m2`), a level on a datum the model
does not share, or a value below a detection limit is reported rather than forced
into the comparison.

In detail:

- **Where.** A station is compared at its own model cell. A station whose cell is
  land (a jetty, a harbour gauge) moves to the nearest sea cell within 3 km, and
  the readout says how far (NIOZ jetty: 489 m on the 500 m grid). Stations within
  **3 cells (at least 1.5 km)** of a point selection, or inside an area selection,
  are set beside it; clicking a station marker makes a point selection tied to it.
- **When.** Both sides are instantaneous, so the denser side is sampled at the
  sparser side's times: a 10-minute record against hourly output is compared at the
  model's hours (nearest observation within tolerance); a monthly bottle sample
  against hourly output at the sample time (model interpolated between the two
  steps around it). Daily model snapshots alias the tide (Dataset ▸ Sampling), and
  that caveat applies to any comparison made with them.
- **Depth.** A time series with a depth is compared with the model's 2-D field
  (surface layer, or the depth-mean `-avg` field), and the readout names both:
  *obs at −1.5 m NAP vs model surface layer (k = 10 of 10)*. Profiles go to the
  Vertical panel, where the model column is interpolated onto every observed depth.
- **Datums.** Two water levels on different datums (gauge on NAP, model zero not
  stated) are compared as **anomalies** about their own means; the offset between
  the means is reported separately, because a datum offset is not a model error.
- **Detection limits.** Values flagged `<` or `>` are drawn (as the measurement
  they are) but left out of every statistic: they are bounds, not values.
- **Surveys on flats.** A sample from a flat that is dry at the sampling moment is
  compared with the model at the nearest wet step within a day.

**Variables the run does not have** are still shown. In the Observations panel a
variable without a counterpart has a dashed outline; clicking it plots a station
collection's record of it in a third panel under the timeseries chart, *observed
only*, at the stations beside the selections (Balgzand epibenthos against a run
that carries Y2c and Y3c but no Y1c), or colours a survey's samples by it on their
own scale. Nothing is scored, because there is nothing to score against.

The numbers: **n**, **bias** (mean model − observation), **RMSE** and Pearson
**r**. Bias and RMSE together, because a near-zero bias with a large RMSE means the
*shape* is wrong even though the average is right. They appear in the readout under
each selection, per collection in the **Model vs obs** tab (a scatter against the
1:1 line, on log axes when the variable's colour scale is logarithmic), and pair by
pair in **Export ▸ Export model–observation pairs as CSV**.

---

## 7. Variable names and units

Observations are matched to model variables through **`obs_vocab.json`**, a single
file read by both the ingest and the viewer, so the two never disagree. Each
*quantity* (`sea_water_temperature`, `significant_wave_height`, `chlorophyll_a`,
`deposit_feeders_carbon`, …) lists the names it goes by, observation columns and
model keys alike (`temp`, `T`, `etw`, `sst`; `hm0`, `hs`, `hs-out`), and its CF
standard names. A model key ending `-avg` is the depth-averaged form of the same
quantity.

A variable that is not recognised is still ingested and shown; it is compared only
when the sidecar names its model counterpart (`"model": ["p1c"]`) or its quantity
(`"quantity": "chlorophyll_a"`). To teach the vocabulary a new name, add it to the
quantity's `aliases`.

**Units** convert within a group (mass concentration, molar concentration, areal
mass, length, velocity, …): `mg/l` → `mg/m3` × 1000, `ug/l` = `mg/m3`,
`umol/l` = `mmol/m3`, `g C/m2` → `mg C/m2` × 1000, `cm/s` → `m/s`, `K` → `degC`.
An **element tag** (`C`, `N`, `P`, `Si`, `Chl`, `AFDM`) must agree when both sides
state one; `ug/l` against `mg Chl/m3` converts, with a note that one side did not
say. A few conversions are only approximate (`g/kg` or `‰` to PSU) and are marked so.
Conversions not in the table (mass ↔ molar, AFDM ↔ carbon) are deliberately absent:
they need a factor that depends on the species or the method, and belong in the
data preparation, where it can be documented.

**Benthos.** The model's benthic groups are carbon per square metre of sea bed
(Y1c epibenthos, Y2c deposit feeders, Y3c suspension feeders, Y4c meiobenthos and
Y5c endobenthos, in mg C/m2), and the vocabulary knows them as `epibenthos_carbon` …
`endobenthos_carbon`, plus `macrozoobenthos_carbon` for their sum. Observations
must arrive **per m2** and **as carbon**. `tools/prepare_benthos.py` does both for
SIBES, SUBES, Balgzand and the subtidal survey with one rule for all four: carbon
= AFDM × the taxon's energy content (kJ/g) / 45.8 kJ/g C, split over the groups
with the MARINETRAITS feeding-mode and bioturbation scores. Watch the area: in the
Balgzand tables a biomass row is the AFDM of *all* animals of a transect or
quadrat in one crucible, so it must be divided by the total surface sampled
(0.08–1.83 m2 by method). The `CL/` and `MSCOP/…raw_FG_as_gC_m2` files are not, and
read about 1.6× too low.

---

## 8. Worked examples

Ready-to-use sidecars for the data used in this project are in
[`examples/observations/`](examples/observations/):

| Sidecar | Data | Becomes |
|---|---|---|
| `nioz_jetty_hourly.json` | TESO `nioz_jetty_hourly.csv.gz` | time series, continuous 1 h, at −1.5 m NAP |
| `nioz_jetty_hw_samples.json` | TESO `nioz_jetty_hw_samples.csv` | time series, discrete ~weekly, day precision |
| `rws_marsdiep_noord_samples.json` | TESO `rws_marsdiep_noord_samples.csv` | time series, discrete, at 1 m depth |
| `rws_denhelder_10min.json` | TESO `rws_denhelder_10min.csv.gz` | time series, continuous 10 min, levels on NAP |
| `rws_wadden_waves.json` | `RWS/waves/processed/rws_wadden_waves.nc` | 31–37 stations, continuous 10 min (CF NetCDF) |
| `rws_mwtl_spm_surface.json` | RWS `MWTL_Turbidity.csv`, split (below) | 114 stations 1972–2021, discrete, 1–4 m below the surface |
| `rws_mwtl_spm_bed.json` | the same export, near-bed part | 12 stations, 1–4 m above the bed |
| `sibes.json` | `tools/prepare_benthos.py sibes` | survey, ~4 000 intertidal stations per summer, 2008–2022 |
| `subes.json` | `tools/prepare_benthos.py subes` | survey, ~400 subtidal stations per spring, 2015–2019 |
| `balgzand.json` | `tools/prepare_benthos.py balgzand` | time series, 12 transects + 3 quadrats, 1967–2019 |
| `subtidal_benthos.json` | `tools/prepare_benthos.py subtidal` | survey, western Wadden subtidal 1981–82 and 2008–10 |
| not needed | `tools/fetch_observations.py` | ICES CTD profiles for an area and period (ERDDAP) |

```powershell
$D = 'path\to\data'     # folder holding the source files
python obs_ingest.py add "$D\TESO\processed\stations\nioz_jetty_hourly.csv.gz" --meta examples\observations\nioz_jetty_hourly.json
python obs_ingest.py add "$D\RWS\waves\processed\rws_wadden_waves.nc" --meta examples\observations\rws_wadden_waves.json
foreach ($b in 'sibes', 'subes', 'balgzand', 'subtidal') {
  python tools\prepare_benthos.py $b "$D" "$b.csv"
}
python obs_ingest.py add sibes.csv    --meta examples\observations\sibes.json
python obs_ingest.py add subes.csv    --meta examples\observations\subes.json
python obs_ingest.py add balgzand.csv --meta examples\observations\balgzand.json
python obs_ingest.py add subtidal.csv --meta examples\observations\subtidal_benthos.json
```

`prepare_benthos.py` prints a check of each result against the processed product
it replaces (Balgzand: identical to `MSCOP/balgzand_feeding_groups_biomass_gC_m2.csv`;
SUBES: Y2/Y3 identical to `feeding_groups_gC_m2_SUBES.csv`, whose Y1/Y5 split used
other trait scores). For the subtidal survey it does **not** apply the seasonal
`corfac` (Beukema 1974): the model is compared on the sampling date.

**A Waterinfo / DONAR / MWTL WFS long export.** These carry the substance in a
description, units and flags per row, positions as WKT, and sampling heights in cm
relative to either the water surface or the bed. Split the export on the reference
level, one file per `referentievlak`, and map the columns:

```powershell
python tools\split_csv.py "$D\Turbidity\raw\MWTL_Turbidity\MWTL_Turbidity.csv" --by referentievlak --keep WATSGL,BODM
python obs_ingest.py add "$D\Turbidity\raw\MWTL_Turbidity\MWTL_Turbidity.WATSGL.csv" --meta examples\observations\rws_mwtl_spm_surface.json
python obs_ingest.py add "$D\Turbidity\raw\MWTL_Turbidity\MWTL_Turbidity.BODM.csv"   --meta examples\observations\rws_mwtl_spm_bed.json
```

The sidecar for a DONAR export looks like this (the MWTL WFS sidecars above differ
only in column names):

```json
{
  "format": "dtv-observations/1",
  "columns": {"code": "station", "naam": "station_name", "tijdstip": "time",
              "parameter_code": "variable", "meetwaarde": "value", "eenheid_code": "units",
              "limietsymbool": "qualifier", "kwaliteitswaardecode": "flag",
              "bemonsteringshoogte": "depth", "geom": "wkt"},
  "vertical_units": "cm", "vertical_positive": "up",
  "flags": {"good": ["00"]}
}
```

**SIBES-style survey data from another programme** need only `station`, `time`
(a date is fine), `lat`/`lon` and one column per variable, with units in the
sidecar; the classifier recognises a survey by itself.

**CTD casts** come from ICES through EMODnet Physics' ERDDAP, for the domain and
period of a dataset or any box and dates, straight into the store:

```powershell
python tools\fetch_observations.py --dataset data\nwes-3nm-aug2015 --id ices-ctd-nwes-2015-08
```

The tool writes an ordinary CSV and sidecar (station = cast, one row per depth) to
`data/observations/_cache/` and ingests them like any other file; the casts are a
**profiles** collection and appear on the Vertical panel of every run they overlap.

---

## 9. The store, the tools, and the limits

**Layout.** `data/observations/index.json` lists the collections; each has
`collection.json` (metadata, variables, stations, report) and its data in
`ts/<station>/<year>.json` (station records), `profiles/<year>.json` (casts) or
`points/<year>.json` (survey samples). The viewer reads `index.json` first and loads
only the station-years and survey-years the open run needs. Everything is plain
JSON, which can be inspected and read from Python or R. The store lives inside the data
volume, so a Docker redeploy keeps it.

**Provenance.** `collection.json` records the input files with their SHA-256, the
time of ingest, the sidecar's credit fields, and every warning and note from the
ingest. The pairs CSV carries the dataset header the other exports carry.

**Tests.** `python tests/test_obs_ingest.py` builds one small file per sampling
geometry (wide, long, survey, profiles, mooring, projected coordinates, CF NetCDF,
benthos groups from before 1970, a relocated station) and checks how each is read
and classified.

**Limits worth knowing.**

- Size: each station-year is one JSON file; a year of 10-minute data for one
  variable is ~0.7 MB. Restrict long records with `--from/--to` (or `time_range`)
  to what the runs cover. Uploads through the viewer are capped at 2 GB
  (`OBS_MAX_MB`).
- A time series is compared with the model's 2-D field, not interpolated in depth
  through the 4-D column store; the readout states both levels. Depth-resolved
  comparison happens on the Vertical panel.
- Survey samples are compared at their own cell; there is no spatial averaging of
  the model over a sample's footprint, and none of the samples over a model cell.
  A Balgzand value is the mean of a 980 m transect, placed at the transect's mean
  position and compared with the one cell there.
- Collections take the seven Okabe–Ito colours in store order; with more than
  seven collections over one run, colours repeat (the legend and the readout name
  the collection).
- The upload API has no authentication, like the `.nc` upload: keep the app on a
  trusted network.
