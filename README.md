<div align="center">

# Digital Twin Viewer

**Interactive 3-D visualization, analysis and validation of coastal and shelf-sea model output in the web browser**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![JavaScript ES modules](https://img.shields.io/badge/JavaScript-ES_modules,_no_build_step-F7DF1E?logo=javascript&logoColor=black)
![Three.js r160](https://img.shields.io/badge/Three.js-r160-000000?logo=threedotjs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23313342.svg)](https://doi.org/10.5281/zenodo.23313342)

</div>

![Six screens of the Digital Twin Viewer: chlorophyll on the North-West European Shelf, a temperature section, modelled profiles against CTD casts, intertidal flats of the Dutch Wadden Sea, a Hovmöller diagram of current speed, and a station time series against observations](docs/media/fig01_viewer_overview.jpg)

**Figure 1.** Screens of the viewer. (a) Surface chlorophyll-a on the North-West
European Shelf, logarithmic colour scale. (b) Temperature section across the
Flamborough front, drawn from all 25 sigma layers. (c) Modelled temperature profiles
at three stations against ICES CTD casts (dashed), with bias and RMSE per station.
(d) Intertidal flats of the Dutch Wadden Sea at spring low water on 22 January 2015,
with animated tidal current trails. (e) Current speed along a 9.4 km channel-to-shore
transect, shown as a Hovmöller diagram (distance against time). (f) Modelled surface
temperature against the hourly record of the NIOZ jetty, with n, bias, RMSE and r.
Model fields are simulated (GETM and GETM-ERSEM-BFM output); the CTD casts in (c) and
the jetty record in (f) are observations. Colour maps: cmocean-style algae (a) and
thermal (b, c, f), and the viewer's current-speed map (e). Relief is vertically
exaggerated 40× (a–c) and 200× (d–f). Satellite imagery © Esri, Maxar, Earthstar
Geographics.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Quick start](#quick-start)
- [Input data](#input-data)
- [Using the viewer](#using-the-viewer)
- [Field observations](#field-observations)
- [Interpreting the display](#interpreting-the-display)
- [Data pipeline and file formats](#data-pipeline-and-file-formats)
- [Example applications and the bundled dataset](#example-applications-and-the-bundled-dataset)
- [Deployment](#deployment)
- [Development](#development)
- [Citation](#citation)
- [Authors](#authors)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Overview

Digital Twin Viewer is an open-source suite of interactive visualization and
post-processing tools for the three-dimensional rendering of ecosystem model output
and intertidal flat dynamics. It integrates observational networks and field data so
that model output can be compared directly with measurements. The tools are designed
to support Digital Twins of coastal and shelf seas, and are intended for coastal
engineers, modellers and scientists, as well as for communicating model results to the
wider scientific community and the public.

The viewer runs in a web browser. A lightweight Python server serves the application
and converts model output into compact binary files that the browser reads directly;
all analysis (time series, sections, profiles, statistics and model–observation
comparison) is computed in the browser.

The viewer reads model output in NetCDF format with a structure similar to that
produced by the GETM hydrodynamic model coupled to the ERSEM and BFM biogeochemical
models (GETM-ERSEM-BFM). The Dutch Wadden Sea and the North-West European Shelf are
example applications; any model output with a comparable structure can be loaded (see
[Input data](#input-data)).

## Features

- **Three-dimensional rendering.** Bathymetry and land as a block diagram with
  sediment strata on the cut sides, satellite imagery on land, and a water surface that
  follows the modelled water level. Vertical exaggeration is adjustable from 20× to
  500× and is always shown on screen.
- **Ecosystem and physical variables.** Any 2-D, 3-D or 4-D variable on the model grid
  (for example temperature, salinity, chlorophyll, nutrients, suspended matter or
  current speed) is draped over the sea surface, with 36 scientific colour maps,
  logarithmic scales and explicit marking of values outside the colour range.
- **Intertidal flat dynamics.** Wetting and drying are taken directly from the model's
  dry cells. An analysis mode classifies cells as flooded, just flooded, recently
  exposed, dry or permanently submerged, and the exposed and flooded flat area is
  computed for every time step.
- **Currents.** Velocity fields are shown as animated particle trails whose speed,
  length and brightness encode current magnitude, together with a derived current speed
  variable.
- **Point, transect and area analysis.** Time series, profiles along a transect,
  Hovmöller diagrams, vertical profiles and sections of 4-D fields, and area statistics
  (mean, median, minimum, maximum, standard deviation) with a 10–90 % band. For
  temperature and salinity columns, the readout reports the potential energy anomaly
  and the surface-to-bed density difference.
- **Model–observation comparison.** Station time series, CTD casts, moorings, spatial
  surveys and moving platforms are loaded from CSV files with a JSON description, or
  from CF-1.8 NetCDF. The model is sampled at each observation's position, time and
  depth, and n, bias, RMSE and Pearson r are reported per station, with a
  model-against-observation scatter plot. A command-line tool retrieves ICES CTD casts
  for any area and period through EMODnet Physics.
- **Reproducible export.** Figures as PNG with a caption bar (dataset, grid, date,
  variable, colour scale, vertical exaggeration and sampling caveats), CSV files with a
  provenance header, selections as JSON, and links that restore the exact view.
- **NetCDF conversion.** Model output can be uploaded in the browser or converted on
  the command line. The grid, time axis, coordinates, vertical grid and variables are
  read from the file.
- **Simple deployment.** The front end consists of plain ES modules with no build step
  and no npm dependencies. The server uses the Python standard library only, and a
  Docker image is provided.

## Quick start

With Docker:

```powershell
docker compose up --build        # then open http://localhost:8501
```

With Python 3.10 or newer:

```powershell
pip install -r requirements.txt  # needed only to convert NetCDF files
python server.py                 # serves http://localhost:8501 and opens the browser
```

On Windows, `run_app.bat` installs the dependencies on first use and starts the server.
The viewer opens on the bundled example dataset. It requires a current desktop web
browser with WebGL support and runs without an internet connection; satellite imagery
is downloaded only when a dataset is converted.

## Input data

The conversion pipeline (`nc_pipeline.py`) recognizes variables by name and shape.

**Required**

| Content | Recognized names | Dimensions |
|---|---|---|
| Bathymetry, positive down, masked or fill-valued on land | `bathymetry`, `bathy`, `depth`, `h` | (y, x) |
| Water elevation, with dry cells as fill values | `elev`, `elevation`, `eta`, `zeta`, `ssh` | (time, y, x) |

**Optional, used when present**

| Content | Recognized names | Used for |
|---|---|---|
| Time coordinate with CF `units` and `calendar` | `time` | dates and time step |
| Latitude and longitude, 1-D or 2-D (curvilinear grids are supported) | `latc`/`lonc`, `latitude`/`longitude`, `lat`/`lon` | positions, cell size, true north, satellite imagery |
| Velocity components along the grid axes, (time, y, x) | `u`/`v`, `uu`/`vv`, `ubar`/`vbar`, CF `eastward_`/`northward_` names | current trails and current speed |
| Layer thickness | `h`, `dz`, `thickness`, `layer_thickness` (time, level, y, x) | sigma-layer geometry for profiles and sections |
| Any other variable on the model grid | any name | colour drapes; 4-D variables are shown at the surface layer |
| Global attribute `title`, vertical datum attributes | | dataset title and datum label |

The number of time steps, the time step, the grid size and the geographic extent are
read from the file. Fill values are applied from `_FillValue` and `missing_value`,
with a tolerance for out-of-band sentinels such as -9999.

**Converting a file.** In the viewer, choose **Dataset** and **Load .nc file**: the file
is uploaded, converted into `data/<name>/` and opened. Converted datasets are listed in
the dataset menu and can be opened directly with `?dataset=<name>` in the URL.

On the command line, conversion offers more control:

```powershell
python nc_pipeline.py <file.nc> data/<name>                          # all variables
python nc_pipeline.py <file.nc> data/<name> --vars temp,salt,chl     # selected variables
python nc_pipeline.py <file.nc> data/<name> --profiles temp,salt     # plus vertical columns
```

Vertical profiles, sections and depth–time diagrams of 4-D fields need a column store,
which is written only for the variables named with `--profiles` (each one also gets a
depth-averaged map). Column stores are large (about 230 MB per variable for a year of
daily output on the 336 × 195 Wadden Sea grid with 10 layers), so they are not built
for browser uploads. Two related commands update an existing dataset:

```powershell
python nc_pipeline.py --latlon <file.nc> data/<name>    # refresh per-cell coordinates only
python satellite.py <file.nc> data/<name>               # fetch or refresh satellite imagery
```

## Using the viewer

### Layout

The window consists of a rail of section icons, a collapsible sidebar, the 3-D view
and a dock of charts. The sidebar and the dock can be resized and collapsed; the 3-D
view uses the remaining space, so no panel covers the model domain. Both panels start
closed. The sidebar sections are **Dataset**, **Variables**, **View**, **Flow**,
**Analysis**, **Export**, **Observations** and **Help**.

The 3-D view carries a status strip (dataset, date, time step, season and tide trend),
a compass pointing to true north, a scale bar with the vertical exaggeration, a colour
bar, a legend and the timeline. Each overlay can be switched off under **View**.

### What is displayed

- **Terrain block.** Bathymetry and land, with procedurally generated sediment strata
  on the cut sides of the block.
- **Water surface.** Semi-transparent and coloured by depth, with waves, sky
  reflection, sun glint and shoreline foam. Where a cell falls dry, the water surface
  drops below the bed and the flat emerges.
- **Wet sand.** Freshly exposed flats are rendered darker and glossy, and dry out over
  the following time steps.
- **Analysis mode** (`M`). Cells are coloured by intertidal state: flooded intertidal
  flats, just flooded in this step, recently fell dry, dry flats, permanent sea and
  land.
- **Land.** Satellite imagery where available, otherwise a procedural land surface.

### Selections and charts

Choose a tool under **Analysis** and click the map.

- **Point.** A single cell. Points can also be placed by latitude and longitude, or by
  grid row and column, and given a name.
- **Transect.** Click the vertices and press `Enter` or double-click to finish. The
  transect visits every cell along the line, and distances are measured along the line
  drawn (geodesic distances when the dataset has per-cell coordinates).
- **Area.** Click a polygon, or hold `Shift` and drag a rectangle. Areas are reduced
  with the mean, median, minimum, maximum or standard deviation, with an optional
  10–90 % band.

Several selections can be overlaid on one chart. Charts show the variable displayed on
the map, in its own units; with no selection they show the domain mean. Water level,
water depth and the domain-wide exposed flat area can be added as extra series; when a
variable is active they are drawn in a separate panel, so quantities in different
units never share an axis.

The dock has five tabs:

| Tab | Content |
|---|---|
| Timeseries | the active variable for every selection through the run, with observations where available |
| Profile | bed elevation and water surface along a transect at the current time step, with the water column coloured by the variable |
| Vertical | vertical profiles of a 4-D variable for points and areas, with a 10–90 % band, the whole-run envelope and observed casts |
| Hovmöller | distance against time along a transect, or depth against time for a point or area |
| Model vs obs | every model–observation pair against the 1:1 line, per collection |

Hovering a chart gives a readout at that point, and dragging along the time axis moves
the 3-D view to that time. Everything is computed in the browser from data already
loaded, so charts update without a server round-trip.

### Keyboard and mouse

| Input | Action |
|---|---|
| Drag, scroll, right-drag | rotate, zoom, pan |
| Hover the map | cell readout: position, bed level, wet or dry, variable value |
| `Space` | play or pause |
| `←` `→` | previous or next time step |
| `M` | switch between realistic and analysis mode |
| `F` | current trails on or off |
| `R` | reset the camera |
| `Esc`, `Enter` | cancel or finish the selection being drawn |
| `Ctrl`+`B` | show or hide the sidebar |
| `Ctrl`+`J` | show or hide the chart dock |
| `1` to `7` | open a sidebar section |
| Timeline, charts, date field | move to any time step |

### Export and sharing

- **Figure (PNG)** at 1× to 4× screen resolution, rendered off-screen. The caption bar
  records the dataset, grid, vertical exaggeration, variable and units, date and time
  step, colour scale and sampling caveats; the north arrow, scale bar and imagery
  attribution are drawn into the image. Charts can be saved as PNG as well.
- **CSV** in long format (one row per selection, time step and series) with a comment
  header that records the dataset, grid, datum, layer, value precision, sampling caveats
  and a link back to the view. Vertical profiles and model–observation pairs have their
  own CSV exports.
- **JSON** with every selection: vertices, the full list of cells in grid and
  geographic coordinates, length or area, and the application state.
- **Link to this view.** Dataset, variable, time step, colour scale, vertical
  exaggeration, camera position and selections are encoded in the URL.

## Field observations

Station records, sampling campaigns, CTD casts and spatial surveys are ingested once
into an observation store (`data/observations/`) and appear with every model run that
overlaps them in space and time. Collections are added in the **Observations** section
(**Load observations**) or on the command line:

```powershell
python obs_ingest.py check my_data.csv --meta my_data.json   # report only
python obs_ingest.py add   my_data.csv --meta my_data.json   # add to the store
python obs_ingest.py list                                    # list the store
```

Each collection is classified from its sampling (time series, depth-resolved time
series, profiles, survey, moving platform) and shown accordingly: station time series
on the Timeseries tab with n, bias, RMSE and r per station, casts and depth-resolved
stations on the Vertical tab, and surveys as points on the map coloured on the same
scale as the model field. The model is always interpolated to the observation, never
the reverse. Comparisons that cannot be made consistently, such as units that do not
convert, values on a different vertical datum or values below a detection limit, are
reported rather than forced.

The file format, the classification rules, the comparison methods and worked examples
are documented in **[OBSERVATIONS.md](OBSERVATIONS.md)**. Example descriptions for the
NIOZ jetty, Rijkswaterstaat monitoring (water quality, suspended matter, waves and
water levels), the SIBES, SUBES and Balgzand benthic surveys and the western Wadden Sea
subtidal survey are provided in `examples/observations/`, and helper scripts in
`tools/`.

### ICES CTD casts

```powershell
python tools/fetch_observations.py --dataset data/<name>
python tools/fetch_observations.py --bbox 50,62,-5,10 --from 2015-08-01 --to 2015-08-31 --vars temp,salt
```

The tool takes the domain and period of a converted dataset (with a margin of 0.25°
and 4 days), or an explicit box and period, retrieves the ICES CTD casts from the
EMODnet Physics ERDDAP server, screens them and ingests them as a profiles collection.
Values with an explicit bad quality flag are rejected and the remainder are screened
on physical range; a profile must have at least four levels spanning at least 5 m. The
result is range-screened rather than quality-controlled. The raw response is cached
in `data/observations/_cache/`, so the selection can be revisited without querying the
server again.

On the Vertical tab, casts within three cells (at least 1.5 km) and ±3 days of a
selection are drawn dashed in the selection's colour. Cast depths are placed below the
modelled water surface at that cell and time. The model column is interpolated onto
the observed depths, never the reverse; depths that the model column does not reach
are skipped, and the number of depths compared is reported with the bias and RMSE.

## Interpreting the display

The viewer is designed so that nothing on screen implies more than the data support.

- **Picking follows the displaced surface.** Because the relief is exaggerated, the
  cell under the cursor is found by intersecting the view ray with the displayed
  surface iteratively, so the readout, the tooltip and selections refer to the same
  cell.
- **Masked cells report no data.** Land and dry cells are filled with nearby values
  for rendering only; readouts and charts suppress these values. The stored water level
  of a dry cell is a fill clamped below the bed, so water-level series are interrupted
  where a cell is dry.
- **Vertical exaggeration** is always shown beside the scale bar and is included in
  exported figures. Charts and readouts are not exaggerated.
- **Vertical datum.** Elevations are reported on the datum stated in the source file,
  or as "not stated in the source file". The datum is never assumed.
- **Layers.** A 4-D variable on the map shows a single layer, which the Variables panel
  and the CSV header identify by its index.
- **Colour scale.** The default range is the 1st to 99th percentile. The colour bar
  marks either end where data fall outside the chosen range. Minimum, maximum, colour
  map, logarithmic scaling and reversal are all adjustable, so dates or datasets can be
  compared on a fixed scale.
- **Value precision.** Variables are stored as 16-bit integers over their true range,
  and the Variables panel states the resulting resolution.
- **Temporal sampling.** Model output sampled every 6 h or less often under-samples
  the semidiurnal tide, so tidal signals appear aliased: with daily output, the tidal
  phase advances by almost two cycles per step. The caveat is stated for the dataset
  (**Dataset**, **Sampling**), under each chart and in every CSV header. Current trails
  follow each time step's instantaneous field and are not particle trajectories.
- **Velocity components.** GETM writes velocities along the model's grid axes rather
  than geographic east and north. The viewer draws the scene in grid coordinates and
  applies the components without rotation; `meta.json` records this as
  `flow.gridAligned`.

## Data pipeline and file formats

`nc_pipeline.py` writes the following files to `data/<name>/`:

| File | Content |
|---|---|
| `meta.json` | grid dimensions and extents, dates and time step, vertical datum, variable descriptions and per-step statistics (exposed and flooded area, mean level, variable minimum, mean and maximum) |
| `terrain.bin` | float32 bed and land elevation (m, positive up); land filled with a gentle rise |
| `masks.bin` | uint8 flags: bit 0 land, bit 1 intertidal (wet at least once and dry at least once) |
| `elev.bin` | int16 water level (cm) per time step; dry cells hold the nearest wet level clamped just below the bed |
| `latlon.bin` | float32 latitude and longitude per cell |
| `flow.bin` | uint8 square-root-coded velocity components per time step, when the file has a velocity pair |
| `var_<key>.u16.bin` | uint16 variable per time step, scaled over the variable's true range |
| `vgrid.bin`, `cellmap.bin` | sigma-layer fractions of the water column per cell, and the map from cells to columns |
| `col_<key>.u16.bin` | full 4-D column store of a variable named with `--profiles`, one contiguous record per cell |
| `satellite.jpg`, `satuv.bin` | satellite image of the domain and per-cell texture coordinates |
| `status.json` | conversion progress |

All binary files are little-endian. Water levels are stored in centimetres; variables
are stored as 16-bit integers over their exact minimum and maximum, which keeps the
relative quantization error near 0.002 % without clipping. Current components are
coded as `b = sign(c)·√(|c|/scale)·127 + 128`, which keeps the relative precision of
slow and fast currents comparable; a linear code scaled to the peak speed would
resolve typical speeds only to about 10 %.

The viewer loads `meta.json`, the terrain, the masks, the water levels, the
coordinates, the currents and the satellite image at start-up. Variables are loaded
when selected, and at most two are held in memory (**Dataset**, **Memory**). Vertical
profiles are requested from the server (`/api/columns`) for the selected cells only,
so a profile never requires loading a whole 4-D field; this is why profiles and
sections need `server.py` rather than a plain static file server.

**Grid coordinates.** GETM grids are often curvilinear and may be rotated relative to
true north (the Dutch Wadden Sea 500 m grid is rotated by about 17°), so latitude and
longitude depend on both row and column. The pipeline therefore stores the coordinates
of every cell in `latlon.bin`, which the viewer samples for readouts, typed positions
and distances. `meta.json` records `hasLatLon` and `gridNorthDeg`, the bearing of the
grid's row axis, which orients the compass. Coordinates masked over land are
reconstructed with a smooth quadratic fit.

**Satellite imagery.** Land is draped with Esri World Imagery, fetched once per dataset
from the file's coordinate grid and stored as `satellite.jpg` with per-cell texture
coordinates in `satuv.bin`, so curvilinear grids are draped correctly. Imagery is
fetched automatically when a dataset is converted and an internet connection is
available. Without imagery, land is rendered procedurally.

## Example applications and the bundled dataset

The viewer has been applied to GETM and GETM-ERSEM-BFM simulations of:

- the **Dutch Wadden Sea**, on a curvilinear 500 m grid of 336 × 195 cells with
  10 sigma layers, with daily and hourly output; and
- the **North-West European Shelf**, on a regular grid of about 5.3 km (400 × 336
  cells) with 25 sigma layers and daily output.

The repository includes one example dataset in `data/default/`, which opens when the
viewer starts: the Dutch Wadden Sea at 500 m resolution, 32 daily snapshots from
1 January 2015, with water level, currents, temperature and salinity (surface layer,
depth average and full column stores) and suspended sediment at the surface. It takes
about 80 MB on disk; a first page load transfers about 12 MB.

The source NetCDF files are not distributed with the repository because of their size.
`preprocess.py` rebuilds `data/default/` from a source file given on the command line
or in the environment variable `WADEMOAAS_SRC_NC`.

## Deployment

### Docker

Docker with Docker Compose is required. From the repository root:

```powershell
docker compose up --build            # foreground
docker compose up -d --build         # background
docker compose logs -f               # follow the logs
docker compose down                  # stop, keeping the data
docker compose down -v               # stop and delete uploaded and converted datasets
```

To publish the viewer on another host port, set `DTV_PORT` (PowerShell:
`$env:DTV_PORT = 8080`) before starting it. The equivalent commands without Compose
are:

```powershell
docker build -t digital-twin-viewer .
docker volume create tidal-flats-data
docker volume create tidal-flats-uploads
docker run --rm -p 8501:8501 -v tidal-flats-data:/app/data -v tidal-flats-uploads:/app/uploads digital-twin-viewer
```

Named volumes keep converted datasets and their uploaded NetCDF files across restarts.
Docker populates a named volume from the image only when the volume is empty, so the
image ships the bundled dataset in `/app/seed/`, and `server.py` copies it into
`/app/data/` at start-up whenever it differs from the copy in the volume. As a result,
a redeployment updates the bundled dataset without affecting uploaded datasets, and a
bundled dataset deleted through the interface is restored at the next start. NetCDF
source files are excluded from the image.

The server reads `HOST` (default `127.0.0.1`; `0.0.0.0` in the container), `PORT`
(default `8501`) and `OBS_MAX_MB`, the size limit for observation uploads (default
2048).

### Security

The viewer is intended for local use or a trusted network. The endpoints that upload,
convert and delete datasets and observation collections have no authentication, and
NetCDF uploads have no size limit. A public deployment requires access control,
request and resource limits, TLS behind a reverse proxy, and durable storage.

### Continuous integration at NIOZ

`.gitlab-ci.yml` builds the image on the NIOZ GitLab instance and pushes it to the
institute's container registry, and `docker-compose.yml` runs that image on the NIOZ
deployment host. Outside NIOZ, use `compose.yaml` (the default for `docker compose`),
which builds the image locally.

## Development

The front end is plain ES modules without a build step. `index.html` loads
`js/app.js`, which assembles the modules in order and runs the frame loop.

| Path | Content |
|---|---|
| `js/core/` | dataset loading (`meta.json` and binary fields), calendar and sampling caveats, cell and coordinate conversion |
| `js/render/` | renderer, camera and controls; GPU data textures and shared uniforms; one module per scene object (terrain, water, block sides, sky, current trails, observation markers); GLSL loading |
| `shaders/` | GLSL programs, one file per stage (`<name>.vert.glsl`, `<name>.frag.glsl`); shared code in `shaders/chunks/`, included with `#include "chunks/<file>.glsl"` |
| `js/features/` | sidebar sections and application state: time, status strip, variables, view controls, selections, typed points, export, datasets, URL state, tooltip, keyboard |
| `js/dock/` | the chart dock, one module per tab, and the readout |
| `js/obs/` | model–observation pairing, map markers and the Observations section |
| `js/*.js` | self-contained libraries: charts, colour maps, observations, selections, time series, vertical profiles, export, URL state, user interface shell, utilities |
| `lib/` | three.js r160 and its OrbitControls add-on |
| `*.py` | `server.py` (static server and processing API), `nc_pipeline.py` (NetCDF conversion), `satellite.py` (imagery), `obs_ingest.py` (observation store), `preprocess.py` (bundled dataset) |
| `tools/` | ICES CTD retrieval, benthos data preparation, CSV splitting, cell-size correction for older datasets, colour table generation |

To add a shader program, add its two files to `shaders/` and its name to `PROGRAMS` in
`js/render/shaderLib.js`; a material then uses `program('<name>')`. The colour tables
in `js/cmapdata.js` are generated by `python tools/gen_cmapdata.py` (requires
`cmcrameri`).

The observation ingest has a test suite that builds one small file per sampling
geometry and checks how each is read and classified:

```powershell
python tests/test_obs_ingest.py      # or: pytest tests/
```

## Citation

If you use Digital Twin Viewer in your work, please cite it using the metadata in
[CITATION.cff](CITATION.cff). GitHub shows a formatted citation under **Cite this
repository**.

## Authors

- **Christos P. Giannopoulos** ·
  ORCID [0000-0003-0973-1275](https://orcid.org/0000-0003-0973-1275) ·
  [christos.giannopoulos@nioz.nl](mailto:christos.giannopoulos@nioz.nl) ·
  GitHub [@cpgiannopoulos](https://github.com/cpgiannopoulos)
- **Petros Giannopoulos** ·
  [petrosyannopoulos@gmail.com](mailto:petrosyannopoulos@gmail.com) ·
  GitHub [@PetrosGiannopoulos](https://github.com/PetrosGiannopoulos)

## License

Digital Twin Viewer is released under the [Apache License, Version 2.0](LICENSE); see
also [NOTICE](NOTICE). Third-party components are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): three.js (MIT) and the Scientific
colour maps by Fabio Crameri (MIT). Satellite imagery is © Esri, Maxar and Earthstar
Geographics, is subject to Esri's terms of use, and is not covered by the Apache
License.

## Acknowledgements

The example applications use output of the GETM hydrodynamic model and the ERSEM and
BFM biogeochemical models. Observations shown in the examples were obtained from ICES
through EMODnet Physics, from Rijkswaterstaat and from NIOZ monitoring programmes.
Three-dimensional rendering uses [three.js](https://threejs.org). Colour maps follow
the Scientific colour maps (Crameri, 2018, <https://doi.org/10.5281/zenodo.1243862>)
and cmocean (Thyng et al., 2016, <https://doi.org/10.5670/oceanog.2016.66>).
