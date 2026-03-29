# -*- mode: python ; coding: utf-8 -*-
import glob
import os

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs

datas = []
binaries = []
hiddenimports = []
tmp_ret = collect_all('deepagents')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('langchain_groq')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('langchain_google_genai')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('langchain_google_vertexai')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('chromadb')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# Chroma loads onnxruntime via importlib — bundle capi DLLs + core module only.
# collect_all('onnxruntime') pulls hundreds of optional onnxruntime.transformers/* modules.
binaries += collect_dynamic_libs('onnxruntime')
hiddenimports += [
    'onnxruntime',
    'onnxruntime.capi.onnxruntime_pybind11_state',
]
# Chroma ONNX uses importlib for tokenizers — must be explicit; include Rust extension .pyd.
try:
    import tokenizers as _tok

    _pkg = os.path.dirname(_tok.__file__)
    for _p in glob.glob(os.path.join(_pkg, '*.pyd')) + glob.glob(
        os.path.join(_pkg, '*.so')
    ):
        binaries.append((_p, 'tokenizers'))
except ImportError:
    pass
hiddenimports += [
    'tokenizers',
    'tokenizers.tokenizers',
    'tokenizers.implementations',
    'tokenizers.tools',
]


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'torch',
        'torchvision',
        'torchaudio',
        'transformers',
        'sentence_transformers',
        'tensorflow',
        'jax',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='rie-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
