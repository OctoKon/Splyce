import hashlib
import pathlib
import sys
import tarfile

original = pathlib.Path(sys.argv[1])
root = pathlib.Path(__file__).resolve().parents[2]
source = root / 'vendor/mocha'
packed = root / 'patches/mocha/mocha-10.8.2.tgz'
assert hashlib.sha512(original.read_bytes()).hexdigest() == '559958a3f584f2dd6db2db919aa81ec818026c973f944768a5a6be6b170acd3049f9421d94007d5e79af4c2007e29c11e0494d22769e7611019990fc88249512'
assert hashlib.sha512(packed.read_bytes()).hexdigest() == '89ee7bd26787c80ca564acdb795b75565232f8a9489b41d44c2dc096043616a7e9432d5b863b93f3244b115c1571f8ed7d17ffc7ed5ac20abfec386f24548a83'
def contents(archive):
    with tarfile.open(archive) as tar:
        return {m.name.removeprefix('package/'): tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
before = contents(original)
after = {p.relative_to(source).as_posix(): p.read_bytes() for p in source.rglob('*') if p.is_file()}
expected = dict(before)
expected['package.json'] = expected['package.json'].replace(b'"minimatch": "^5.1.6"', b'"minimatch": "11.0.1"')
expected['lib/cli/collect-files.js'] = expected['lib/cli/collect-files.js'].replace(b"const minimatch = require('minimatch');", b"const {minimatch} = require('minimatch');")
assert before != expected and expected == after == contents(packed)
print(f'{len(after)} files match original plus two changes and packed archive')
