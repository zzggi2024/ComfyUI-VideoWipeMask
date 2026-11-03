
import base64 as _base64
import importlib.abc as _ia
import importlib.util as _iu
import json as _json
import sys as _sys
from pathlib import Path as _Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

WEB_DIRECTORY = "web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_RUNTIME_PATH = _Path(__file__).resolve().parent / "_shaobkj_runtime.sbgc"
_RUNTIME_MAGIC = b"SBGHRT1"
_RUNTIME_AAD = b"Shaobkj license runtime v1"
_RUNTIME_FORMAT = 1
_PACKAGE_HASH = '58cfaace9dc95ce029391e9919655406638c29aae481ef65b28e2dbfdf613b4e'
_RUNTIME_KEY_MASKED = 'c9qGnHTZkMwpVbkeBsAWRhZCfiEsqUYLwRM/Pp49XlE='
_RUNTIME_KEY_MASK = 'oNMwh6uxk328gxG4QEW5u/01xux4hV3vWft6hpAVK78='

def _runtime_key():
    masked = _base64.b64decode(_RUNTIME_KEY_MASKED)
    mask = _base64.b64decode(_RUNTIME_KEY_MASK)
    return bytes(left ^ right for left, right in zip(masked, mask))

def _load_runtime():
    try:
        payload = _RUNTIME_PATH.read_bytes()
        if not payload.startswith(_RUNTIME_MAGIC):
            raise ValueError("runtime magic mismatch")
        offset = len(_RUNTIME_MAGIC)
        nonce = payload[offset:offset + 12]
        encrypted = payload[offset + 12:]
        plaintext = AESGCM(_runtime_key()).decrypt(nonce, encrypted, _RUNTIME_AAD)
        document = _json.loads(plaintext.decode("utf-8"))
        if document.get("format") != _RUNTIME_FORMAT:
            raise ValueError("runtime format mismatch")
        modules = document.get("modules")
        entry = document.get("entry")
        if not isinstance(modules, dict) or not isinstance(entry, str) or not entry:
            raise ValueError("runtime manifest invalid")
        normalized = {}
        for name, source in modules.items():
            if not isinstance(name, str) or not isinstance(source, str):
                raise TypeError("runtime module invalid")
            normalized[name.replace("\\", "/")] = source
        return normalized, entry
    except Exception as exc:
        raise RuntimeError("授权运行时完整性校验失败。") from exc

_RUNTIME_MODULES, _RUNTIME_ENTRY = _load_runtime()

class _RuntimeLoader(_ia.Loader):
    def __init__(self, fullname, source):
        self.fullname = fullname
        self.source = source

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__file__ = f"<{self.fullname}>"
        module.__loader__ = self
        module.__cached__ = None
        module.__package__ = self.fullname.rpartition(".")[0]
        exec(compile(self.source, module.__file__, "exec"), module.__dict__)

class _RuntimeFinder(_ia.MetaPathFinder):
    _shaobkj_runtime_owner = __name__

    def find_spec(self, fullname, path=None, target=None):
        prefix = __name__ + "."
        if not fullname.startswith(prefix):
            return None
        relative = fullname[len(prefix):].replace(".", "/") + ".py"
        source = _RUNTIME_MODULES.get(relative)
        if source is None:
            return None
        return _iu.spec_from_loader(
            fullname,
            _RuntimeLoader(fullname, source),
            origin=f"<{relative}>",
        )

for _finder in tuple(_sys.meta_path):
    if getattr(_finder, "_shaobkj_runtime_owner", None) == __name__:
        _sys.meta_path.remove(_finder)
_sys.meta_path.insert(0, _RuntimeFinder())

_SHAOBKJ_PACKAGE_HASH = _PACKAGE_HASH
exec(compile(_RUNTIME_ENTRY, "<shaobkj-runtime>", "exec"), globals())

