import json
import os
import sys

import vapoursynth as vs
from vapoursynth import core

runtime_dir = os.path.dirname(__file__)
scripts_dir = os.path.join(runtime_dir, "scripts")

# Load helper scripts explicitly by file path (avoids VapourSynth sys.path issues)
import importlib.util
import types

def _load_script(name):
    path = os.path.join(scripts_dir, name + ".py")
    if not os.path.exists(path):
        raise RuntimeError(f"Missing script: {path}. Please reinstall the motion engine.")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# Build a fake 'scripts' package so blending.py's 'from scripts import weighting' works
scripts_pkg = types.ModuleType("scripts")
scripts_pkg.__path__ = [scripts_dir]
sys.modules["scripts"] = scripts_pkg

# Load dependencies into the fake package
scripts_pkg.consts = _load_script("consts")
scripts_pkg.weighting = _load_script("weighting")
sys.modules["scripts.consts"] = scripts_pkg.consts
sys.modules["scripts.weighting"] = scripts_pkg.weighting

# Now load blending — its internal imports resolve via sys.modules["scripts"]
blending = _load_script("blending")

# havsfunc has no external script deps, load normally
havsfunc = _load_script("havsfunc")

YES = {"yes", "true", "on", "1", "y"}


def _yes(v):
    return str(v).lower() in YES


if "input_video" not in globals() or "recipe" not in globals():
    raise NameError("xype_motion.vpy requires input_video and recipe VSPipe arguments")

if isinstance(input_video, bytes):
    input_video = input_video.decode("utf-8")
if isinstance(recipe, bytes):
    recipe = recipe.decode("utf-8")

rc = json.loads(recipe)["data"]

# -- Source --
sp = rc["miscellaneous"].get("source plugin", "bestsource").lower()
if sp in {"bs", "bestsource", "best source"} and hasattr(core, "bs"):
    clip = core.bs.VideoSource(input_video)
elif sp in {"lsmas", "lsmash", "lwsmashsource"} and hasattr(core, "lsmas"):
    clip = core.lsmas.LWLibavSource(input_video)
elif hasattr(core, "ffms2"):
    clip = core.ffms2.Source(input_video)
else:
    raise RuntimeError("No supported VapourSynth source plugin found")

clip = core.resize.Bicubic(
    clip,
    format=vs.YUV420P8,
    matrix_in_s="709",
    transfer_in_s="709",
    primaries_in_s="709",
    matrix_s="709",
    transfer_s="709",
    primaries_s="709",
    range_in_s="limited",
    range_s="limited",
)

# -- Input timescale --
in_scale = float(rc["timescale"].get("in", "1.0"))
if in_scale != 1.0:
    clip = core.std.AssumeFPS(clip, fpsnum=int(clip.fps / in_scale))

# -- Interpolation (SVPFlow via havsfunc.InterFrame) --
ip = rc["interpolation"]
if _yes(ip.get("enabled", "no")):
    target_fps_str = ip.get("fps", "360")
    if target_fps_str.endswith("x") or target_fps_str.startswith("x"):
        target_fps = int(target_fps_str.strip("x")) * clip.fps
    else:
        target_fps = float(target_fps_str)

    clip = havsfunc.InterFrame(
        Input=clip,
        GPU=ip.get("use gpu", "no").lower() in YES,
        Preset=ip.get("speed", "medium"),
        Tuning=ip.get("tuning", "weak"),
        NewNum=target_fps,
        NewDen=1,
        OverrideAlgo=int(ip.get("algorithm", "23")),
        OverrideBlockSize=ip.get("block size", "auto"),
        OverrideArea=None,
    )

# -- FlowBlur --
flow = rc["flowblur"]
if _yes(flow.get("enabled", "no")):
    super_clip = core.mv.Super(clip, 16, 16, rfilter=3)
    bvec = core.mv.Analyse(super_clip, isb=True, blksize=16, plevel=2, dct=5)
    fvec = core.mv.Analyse(super_clip, blksize=16, plevel=2, dct=5)
    clip = core.mv.FlowBlur(clip, super_clip, bvec, fvec, blur=int(flow.get("amount", "125")))

# -- Frame blending --
blend = rc["frame blending"]
if _yes(blend.get("enabled", "no")):
    target_fps = float(blend.get("fps", "60"))
    input_fps = clip.fps_num / clip.fps_den
    if target_fps >= (input_fps + 1):
        pass  # skip: input fps lower than target
    else:
        # Map frontend weighting names to Smoothie weighting.py function names
        _W_MAP = {
            "equal": "equal",
            "gaussian": "gaussian",
            "pyramid": "pyramid",
            "vegas": "ascending",
            "bright blend": "ascending",
            "heavy light": "descending",
        }
        raw_w = blend.get("weighting", "equal")
        # If custom weights (space-separated numbers), use divide; otherwise map
        if " " in str(raw_w) or "," in str(raw_w):
            blend["weighting"] = "divide"
            blend["weights"] = raw_w
        else:
            blend["weighting"] = _W_MAP.get(raw_w, "equal")

        blend.setdefault("bright blend", "no")

        weights = blending.parse_weights2(clip, blend)
        clip = blending.FrameBlend(clip, blend, False, weights=weights)
        clip = havsfunc.ChangeFPS(clip, int(target_fps))

# -- Output timescale --
out_scale = float(rc["timescale"].get("out", "1.0"))
if out_scale != 1.0:
    clip = core.std.AssumeFPS(clip, fpsnum=int(clip.fps * out_scale))

clip.set_output()
