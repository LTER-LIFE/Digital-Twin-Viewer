# -*- coding: utf-8 -*-
"""Build DTV observation CSVs of macrozoobenthos carbon per ERSEM-BFM feeding
group, ready for obs_ingest.py.

    python tools/prepare_benthos.py sibes    <Data dir> sibes.csv
    python tools/prepare_benthos.py subes    <Data dir> subes.csv
    python tools/prepare_benthos.py balgzand <Data dir> balgzand.csv
    python tools/prepare_benthos.py subtidal <Data dir> subtidal.csv
    python obs_ingest.py add balgzand.csv --meta examples/observations/balgzand.json

<Data dir> is the folder that holds SIBES_v4/, SUBES/, Balgzand_benthos/,
Subtidal_benthos_1981-1982_2008-2010/ and MARINETRAITS/. Needs pandas (this
runs on a workstation, not in the viewer's container).

What every output has in common
-------------------------------
One row per sample (SIBES, SUBES, subtidal survey) or per station and campaign
(Balgzand), one column per variable, all in g C per m2 of sea bed so that the
viewer converts them to the model's mg C/m2 with a plain factor of 1000:

    epibenthos          Y1   carnivore/grazer share of epifaunal taxa
    deposit_feeders     Y2   deposit-feeding share
    suspension_feeders  Y3   suspension-feeding share
    endobenthos         Y5   carnivore/grazer share of infaunal taxa
    total_carbon        Y1+Y2+Y3+Y5, plus taxa without traits

Carbon is gC = AFDM x energy content (kJ/g AFDM) / 45.8 (kJ/g C), with each
taxon's own energy content (22.5 kJ/g where none is known). Taxa are split over
the groups with the fuzzy MARINETRAITS scores (Traits_updated_LKS.csv) by the
rule of the existing SIBES/SUBES/Balgzand workbooks:

    Y2 = DF / sum(feeding)      Y3 = SF / sum(feeding)
    Y1 = epifaunal share of bioturbation x (opportunist+grazer+predator) share
    Y5 = infaunal share of bioturbation  x (opportunist+grazer+predator) share

matched by AphiaID, then exact name, then genus mean.

Per programme
-------------
sibes     The published SIBES_v4_feeding_groups_gC_m2.csv (already per m2,
          gap-filled biota) for the groups; samples.csv for grain size and mud;
          raw biota for total AFDM. Cores absent from the feeding-group table
          were not sorted for fauna and keep an empty biomass.
subes     Rebuilt from merged_data biota (afdm_m2 is per m2). Samples without
          biota rows are left empty rather than set to 0: whether they were
          sorted is not recorded. Checked against
          Data_processing_LFG_SUBES/feeding_groups_gC_m2_SUBES.csv.
balgzand  Rebuilt from raw BIO-Vj (late winter) and BIO-Zo (late summer). The
          afdw of a row is the ash-free dry mass in ONE crucible for the whole
          transect or quadrat, so  g/m2 = sum(afdw x mult) / opp  with opp the
          total surface of the BIO method (METHODS.csv, 0.08-1.83 m2). The
          per-row feeding-group columns of balgzand_benthos_processing.xlsx --
          and the CL/ and MSCOP/*raw_FG_as_gC_m2 files built from them -- are
          g C per crucible, NOT per m2. Checked against MSCOP/
          balgzand_feeding_groups_biomass_gC_m2.csv, which does divide.
          Positions are the transect/quadrat means in POSITIONS.csv.
subtidal  Dekker subtidal survey (1981-82 grab + flushing sampler; 2008-10 box
          corer): g/m2 = afdw x mult / surface. Unlike the trend analysis, the
          seasonal 'corfac' (scaling to the Oct-Nov level, Beukema 1974) is NOT
          applied: the model is compared on the sampling date. Samplings
          recorded as failed (V/F leeg, geen V, F onvoll.) are dropped; 'LEEG'
          samples are real empty samples (0).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

KJ_PER_GC = 45.8
ENERGY_DEFAULT = 22.5
FEED = ["Deposit-feeder", "Suspension-feeder", "Opportunist/scavenger", "Grazer", "Predator"]
BIOT = ["Epifauna", "Surficial modifiers", "Upward conveyors", "Downward conveyors",
        "Biodiffusors", "Regenerators"]
YS = ["Y1", "Y2", "Y3", "Y5"]
OUT_FG = {"Y1": "epibenthos", "Y2": "deposit_feeders", "Y3": "suspension_feeders", "Y5": "endobenthos"}


def log(msg):
    print(f"[benthos] {msg}", flush=True)


# ------------------------------------------------------------------ traits
def trait_fractions(data: Path) -> pd.DataFrame:
    """Y1/Y2/Y3/Y5 fractions per AphiaID from the fuzzy trait scores."""
    t = pd.read_csv(data / "MARINETRAITS" / "Traits_updated_LKS.csv", encoding="utf-8-sig")
    t = t.drop_duplicates("AphiaID")
    f = t[FEED].fillna(0).astype(float)
    b = t[BIOT].fillna(0).astype(float)
    fs = f.sum(axis=1).replace(0, np.nan)
    bs = b.sum(axis=1)
    other = f[["Opportunist/scavenger", "Grazer", "Predator"]].sum(axis=1) / fs
    # no bioturbation code: the carnivore/grazer share counts as infaunal
    epi = (b["Epifauna"] / bs.replace(0, 1.0)).where(bs > 0, 0.0)
    out = pd.DataFrame({"aphia_id": t["AphiaID"].astype(int),
                        "name": t["Scientific Name"].astype(str).str.strip(),
                        "Y1": epi * other, "Y2": f["Deposit-feeder"] / fs,
                        "Y3": f["Suspension-feeder"] / fs, "Y5": (1 - epi) * other})
    return out[out[YS].notna().all(axis=1)].reset_index(drop=True)


def species_table(species: pd.DataFrame, data: Path) -> pd.DataFrame:
    """species (code, name, aphia_id, energy) -> + Y fractions and match method."""
    tr = trait_fractions(data)
    by_aphia = tr.set_index("aphia_id")[YS]
    by_name = tr.assign(k=tr["name"].str.lower()).drop_duplicates("k").set_index("k")[YS]
    by_genus = tr.assign(g=tr["name"].str.split().str[0].str.lower()).groupby("g")[YS].mean()
    rows, how = [], []
    for _, r in species.iterrows():
        nm = str(r["name"] or "").replace(" indet.", "").replace(" indet", "").strip()
        a = pd.to_numeric(r["aphia_id"], errors="coerce")
        if pd.notna(a) and int(a) in by_aphia.index:
            rows.append(by_aphia.loc[int(a)].values); how.append("aphia")
        elif nm.lower() in by_name.index:
            rows.append(by_name.loc[nm.lower()].values); how.append("name")
        elif nm and nm.split()[0].lower() in by_genus.index:
            rows.append(by_genus.loc[nm.split()[0].lower()].values); how.append("genus")
        else:
            rows.append([np.nan] * 4); how.append("none")
    out = species[["code", "name"]].copy().reset_index(drop=True)
    out[YS] = np.array(rows, float)
    out["energy"] = pd.to_numeric(species["energy"], errors="coerce").fillna(ENERGY_DEFAULT).values
    out["match"] = how
    n = out["match"].value_counts().to_dict()
    log(f"traits: {len(out)} taxa — " + ", ".join(f"{k} {v}" for k, v in n.items()))
    return out.set_index("code")


def to_groups(long: pd.DataFrame, sp: pd.DataFrame, key, code_col) -> pd.DataFrame:
    """Per-taxon g C/m2 rows -> per-sample group totals. Carbon of a taxon
    without traits stays in the total, so totals are never silently lost."""
    x = long.copy()
    for y in YS:
        x[y] = x["gC_m2"] * x[code_col].map(sp[y]).fillna(0)
    return x.groupby(key)[YS + ["gC_m2", "afdm_m2"]].sum()


# ------------------------------------------------------------------ writer
def write_csv(df: pd.DataFrame, out: str):
    tmp = f"{out}.part{os.getpid()}"
    df.to_csv(tmp, index=False, float_format="%.6g", lineterminator="\n")
    os.replace(tmp, out)
    log(f"{len(df)} rows -> {out}")


def finish(df: pd.DataFrame, grp: pd.DataFrame | None) -> pd.DataFrame:
    if grp is not None:
        for y in YS:
            df[OUT_FG[y]] = df[y]
        df["total_carbon"] = df["gC_m2"]
        df["afdm_total"] = df["afdm_m2"]
    return df


def compare(name, mine: pd.Series, ref: pd.Series):
    j = pd.concat([mine.rename("a"), ref.rename("b")], axis=1, join="inner").dropna()
    if not len(j):
        log(f"check {name}: nothing in common")
        return
    d = (j.a - j.b).abs()
    r = np.corrcoef(j.a, j.b)[0, 1] if j.a.std() > 0 and j.b.std() > 0 else float("nan")
    log(f"check {name}: n {len(j)}, r {r:.5f}, max |diff| {d.max():.3g} g C/m2, "
        f"means {j.a.mean():.3f} vs {j.b.mean():.3f}")


# ------------------------------------------------------------------ SIBES
def sibes(data: Path) -> pd.DataFrame:
    d = data / "SIBES_v4"
    smp = pd.read_csv(d / "raw" / "samples.csv")
    fg = pd.read_csv(d / "sibes_processing" / "SIBES_v4_feeding_groups_gC_m2.csv")
    afdm = pd.read_csv(d / "raw" / "biota.csv", usecols=["sample_id", "afdm_m2"])
    afdm = afdm.groupby("sample_id")["afdm_m2"].sum()
    cols = {"epibenthos_Y1_c": "epibenthos", "deposit_feeders_Y2_c": "deposit_feeders",
            "suspension_feeders_Y3_c": "suspension_feeders", "endobenthos_Y5_c": "endobenthos"}
    fg = fg.set_index("sample_id")[list(cols)].rename(columns=cols)
    out = smp.join(fg, on="sample_id")
    sorted_ = out["sample_id"].isin(fg.index)
    out["total_carbon"] = out[list(cols.values())].sum(axis=1, min_count=1)
    out["afdm_total"] = np.where(sorted_, out["sample_id"].map(afdm).fillna(0.0), np.nan)
    out = pd.DataFrame({
        "station": "SIBES-" + out["sampling_station_id"].astype(str), "time": out["date"],
        "lat": out["y"], "lon": out["x"],
        "median_grain_size": out["median_grain_size"], "percentage_mud": out["percentage_mud"],
        "afdm_total": out["afdm_total"], **{c: out[c] for c in cols.values()},
        "total_carbon": out["total_carbon"]})
    log(f"SIBES: {sorted_.sum()} of {len(smp)} cores sorted for fauna")
    return out


# ------------------------------------------------------------------ SUBES
def subes(data: Path) -> pd.DataFrame:
    d = data / "SUBES" / "merged_data"
    sp = pd.read_csv(d / "species_with_energy_content.csv").rename(
        columns={"species_id": "code", "energy_content": "energy"})
    sp = species_table(sp, data)
    smp = pd.read_csv(d / "samples.csv")
    sed = pd.read_csv(d / "sediment.csv")
    b = pd.read_csv(d / "biota.csv")
    b["gC_m2"] = b["afdm_m2"] * b["species_id"].map(sp["energy"]).fillna(ENERGY_DEFAULT) / KJ_PER_GC
    g = to_groups(b, sp, "sample_id", "species_id")
    ab = b.groupby("sample_id")["abundance_m2"].sum()
    out = smp.merge(sed, on="sample_id", how="left").join(g, on="sample_id")
    out = finish(out, g)
    out["abundance"] = out["sample_id"].map(ab)
    ref = pd.read_csv(data / "Data_processing_LFG_SUBES" / "feeding_groups_gC_m2_SUBES.csv")
    ref = ref.set_index("sample_id")
    mine = out.set_index("sample_id")
    for y, col in [("Y1", "epibenthos_Y1_c"), ("Y2", "deposit_feeders_Y2_c"),
                   ("Y3", "suspension_feeders_Y3_c"), ("Y5", "endobenthos_Y5_c")]:
        compare(f"SUBES {y} vs feeding_groups_gC_m2_SUBES", mine[y], ref[col])
    log(f"SUBES: {g.index.size} of {len(smp)} samples with fauna; the rest left empty")
    return pd.DataFrame({
        "station": "SUBES-" + out["sampling_station_id"].astype(str), "time": out["date"],
        "lat": out["y"], "lon": out["x"],
        "median_grain_size": out["median"], "percentage_mud": out["silt"],
        "afdm_total": out["afdm_total"], "abundance": out["abundance"],
        **{OUT_FG[y]: out[OUT_FG[y]] for y in YS}, "total_carbon": out["total_carbon"]})


# ------------------------------------------------------------------ Balgzand
BALG_NAMES = {"Sl": "Balgzand PQ Sl", "Dk": "Balgzand PQ Dk", "Mz": "Balgzand PQ Mz"}


def balgzand(data: Path) -> pd.DataFrame:
    raw = data / "Balgzand_benthos" / "raw"
    sp = pd.read_csv(raw / "SPECIES_ADJ_WITH_ENERGY_CONTENT.csv", encoding="utf-8-sig").rename(
        columns={"nspec": "code", "species": "name", "energy_content_kJ_g_AFDW": "energy"})
    sp = species_table(sp, data)
    opp = pd.read_csv(raw / "METHODS.csv", encoding="utf-8-sig").set_index("meth")["opp"]
    dates = pd.read_csv(raw / "DATES.csv", encoding="utf-8-sig")
    dates["date"] = pd.to_datetime(dates["date"], dayfirst=True)
    pos = pd.read_csv(raw / "POSITIONS.csv", encoding="utf-8-sig")
    pos = pos[pos["station"].isna()].rename(columns={"transect/PQ Id": "stat", "N": "lat", "E": "lon"})
    parts = []
    for f, season in [("BIO-Vj.csv", "late winter"), ("BIO-Zo.csv", "late summer")]:
        b = pd.read_csv(raw / f, encoding="utf-8-sig")
        b["season"] = season
        parts.append(b)
    b = pd.concat(parts, ignore_index=True)
    b["area"] = b["meth"].map(opp)
    bad = ~(b["area"] > 0)
    if bad.any():
        log(f"Balgzand: {bad.sum()} biomass rows of {b.loc[bad, 'sampling'].nunique()} samplings "
            f"have a method without a sampled surface — dropped")
    b = b[~bad].copy()
    b["mult"] = b["mult"].fillna(1)
    # afdw is the crucible for the WHOLE transect/quadrat: divide by its surface
    b["afdm_m2"] = b["afdw"].fillna(0) * b["mult"] / b["area"]
    b["gC_m2"] = b["afdm_m2"] * b["Nspec"].map(sp["energy"]).fillna(ENERGY_DEFAULT) / KJ_PER_GC
    g = to_groups(b, sp, ["sampling", "season"], "Nspec").reset_index()
    ev = g.merge(dates[["sampling", "stat", "date"]], on="sampling", how="left")
    ev = ev.merge(pos[["stat", "lat", "lon"]], on="stat", how="left")
    miss = ev["lat"].isna() | ev["date"].isna()
    if miss.any():
        log(f"Balgzand: {miss.sum()} campaigns without a date or position — dropped")
    ev = finish(ev[~miss].copy(), g)

    ref = pd.read_csv(data / "Balgzand_benthos" / "processing" / "MSCOP"
                      / "balgzand_feeding_groups_biomass_gC_m2.csv").set_index("sample_id")
    mine = ev.groupby("sampling")[YS].sum()
    for y, col in [("Y1", "epibenthos_Y1_c"), ("Y2", "deposit_feeders_Y2_c"),
                   ("Y3", "suspension_feeders_Y3_c"), ("Y5", "endobenthos_Y5_c")]:
        compare(f"Balgzand {y} vs MSCOP biomass_gC_m2", mine[y], ref[col])
    raw_fg = pd.read_csv(data / "Balgzand_benthos" / "processing" / "MSCOP"
                         / "balgzand_feeding_groups_raw_FG_as_gC_m2.csv").set_index("sample_id")
    tot = mine.sum(axis=1)
    rtot = raw_fg[[c for c in raw_fg.columns if c.endswith("_c")]].sum(axis=1)
    j = pd.concat([tot, rtot], axis=1, join="inner").dropna()
    j = j[j.iloc[:, 1] > 0]
    log(f"Balgzand: per-m2 / per-crucible ('raw_FG_as_gC_m2') totals: median ratio "
        f"{(j.iloc[:, 0] / j.iloc[:, 1]).median():.2f} — that file is not per m2")

    kind = np.where(ev["stat"].str.len() == 1, "transect", "quadrat")
    name = [BALG_NAMES.get(s, f"Balgzand transect {s}") for s in ev["stat"]]
    return pd.DataFrame({
        "station": "BALG-" + ev["stat"], "station_name": name, "time": ev["date"].dt.strftime("%Y-%m-%d"),
        "lat": ev["lat"], "lon": ev["lon"], "campaign": ev["season"], "kind": kind,
        "afdm_total": ev["afdm_total"],
        **{OUT_FG[y]: ev[OUT_FG[y]] for y in YS}, "total_carbon": ev["total_carbon"],
    }).sort_values(["station", "time"])


# ------------------------------------------------------------------ subtidal
FAILED = r"leeg|geen V|onvoll"


def subtidal(data: Path) -> pd.DataFrame:
    raw = data / "Subtidal_benthos_1981-1982_2008-2010" / "raw"
    d = pd.concat([pd.read_csv(f, encoding="utf-8-sig") for f in sorted(raw.glob("*.csv"))],
                  ignore_index=True)
    d = d[d["sampling"].notna()].copy()
    d["sampling"] = d["sampling"].astype(int)
    d["date"] = pd.to_datetime(d["date"], format="%d/%m/%y")
    # species numbers are the NIOZ-COS ones Balgzand uses
    bal = pd.read_csv(data / "Balgzand_benthos" / "raw" / "SPECIES_ADJ_WITH_ENERGY_CONTENT.csv",
                      encoding="utf-8-sig").set_index("nspec")
    names = d.drop_duplicates("nspec").set_index("nspec")["species"]
    sp = pd.DataFrame({"code": names.index, "name": names.values,
                       "aphia_id": names.index.map(bal["aphia_id"]),
                       "energy": names.index.map(bal["energy_content_kJ_g_AFDW"])})
    sp = species_table(sp, data)
    rem = d["remarks"].fillna("")
    failed = set(d.loc[rem.str.contains(FAILED, case=False, regex=True)
                       & ~rem.str.contains("lege schelpen", case=False), "sampling"])
    meta = d.groupby("sampling").agg(date=("date", "first"), lat=("Deg N", "first"), lon=("Deg E", "first"),
                                     bed=("depth", "first"), d50=("medgrain", "first"), mud=("silt", "first"))
    log(f"subtidal: {len(failed)} of {len(meta)} samplings recorded as failed — dropped")
    meta = meta[~meta.index.isin(failed)]
    x = d[d["sampling"].isin(meta.index) & (d["species"] != "LEEG") & d["afdw"].notna()].copy()
    x["mult"] = x["mult"].fillna(1)
    x["afdm_m2"] = x["afdw"] * x["mult"] / x["surface"]
    x["gC_m2"] = x["afdm_m2"] * x["nspec"].map(sp["energy"]).fillna(ENERGY_DEFAULT) / KJ_PER_GC
    x["n_m2"] = x["n"].fillna(0) * x["mult"] / x["surface"]
    g = to_groups(x, sp, "sampling", "nspec")
    out = meta.join(g, how="left")
    out[YS + ["gC_m2", "afdm_m2"]] = out[YS + ["gC_m2", "afdm_m2"]].fillna(0.0)   # empty samples
    out = finish(out, g)
    out["abundance"] = x.groupby("sampling")["n_m2"].sum().reindex(out.index).fillna(0.0)
    # the trend analysis applies corfac; reproduce it here once as a check
    cf = x.assign(c=x["gC_m2"] * x["corfac"].fillna(1)).groupby("sampling")["c"].sum()
    p = data / "Benthos_feeding_mode_trends" / "processed" / "subtidal_samples.parquet"
    if p.exists():
        try:
            ref = pd.read_parquet(p).set_index("sampling")["total"]
            compare("subtidal total (with corfac) vs trend analysis", cf, ref)
        except Exception as e:                       # no parquet engine: skip the check
            log(f"subtidal: check skipped ({e})")
    period = np.where(out["date"].dt.year <= 1982, "1981-82", out["date"].dt.year.astype(str))
    return pd.DataFrame({
        "station": [f"SUBT-{s}" for s in out.index], "time": out["date"].dt.strftime("%Y-%m-%d"),
        "lat": out["lat"], "lon": out["lon"], "period": period,
        "bed_level": out["bed"], "median_grain_size": out["d50"], "percentage_mud": out["mud"],
        "afdm_total": out["afdm_total"], "abundance": out["abundance"],
        **{OUT_FG[y]: out[OUT_FG[y]] for y in YS}, "total_carbon": out["total_carbon"]})


BUILDERS = {"sibes": sibes, "subes": subes, "balgzand": balgzand, "subtidal": subtidal}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("programme", choices=sorted(BUILDERS))
    ap.add_argument("data", help="the Data folder holding the programme folders and MARINETRAITS/")
    ap.add_argument("out", help="CSV to write")
    ap.add_argument("--from", dest="y0", type=int, default=None, help="first year to keep")
    ap.add_argument("--to", dest="y1", type=int, default=None, help="last year to keep")
    a = ap.parse_args(argv)
    df = BUILDERS[a.programme](Path(a.data))
    yr = pd.to_datetime(df["time"]).dt.year
    keep = pd.Series(True, index=df.index)
    if a.y0:
        keep &= yr >= a.y0
    if a.y1:
        keep &= yr <= a.y1
    write_csv(df[keep], a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
