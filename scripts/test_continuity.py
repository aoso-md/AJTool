import importlib.util,json,shutil,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('continuity',Path(__file__).with_name('continuity.py'))
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)
ORIGINAL_ROOT=tool.ROOT

class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.allowed=ORIGINAL_ROOT/'artifacts/t'
        self.allowed.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='',dir=self.allowed)
        self.root=Path(self.temp.name).resolve()
        tool.ROOT=self.root;tool.MEMORY=self.root/'docs/continuity'
        shutil.copytree(ORIGINAL_ROOT/'docs/continuity',tool.MEMORY)
        s=tool.state()
        for key in ['reviewEvidence','package','manifest']:
            source=ORIGINAL_ROOT/s['localDelivery'][key];dest=self.root/s['localDelivery'][key]
            dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest)
        self.vault=self.root/'test-vault';(self.vault/'.obsidian').mkdir(parents=True)
    def tearDown(self):
        tool.ROOT=ORIGINAL_ROOT;tool.MEMORY=ORIGINAL_ROOT/'docs/continuity'
        assert self.root.resolve().is_relative_to(self.allowed.resolve())
        self.temp.cleanup()
    def test_evidence_claims_match(self):
        self.assertEqual(tool.check()['localTests'],375)
    def test_modified_delivery_is_detected(self):
        p=self.root/tool.state()['localDelivery']['package'];p.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'hash mismatch'):tool.check()
    def test_dry_run_does_not_write_vault(self):
        result=tool.sync(self.vault)
        self.assertFalse(result['applied']);self.assertFalse((self.vault/'06_Agents_Reports').exists())
    def test_sync_is_idempotent_and_preserves_human_note(self):
        note=self.vault/'human.md';note.write_text('Preserve me')
        a=tool.sync(self.vault,True);b=tool.sync(self.vault,True)
        self.assertEqual(a['version'],b['version']);self.assertEqual(note.read_text(),'Preserve me')
        self.assertTrue((Path(a['target'])/a['version']/'CURRENT.md').exists())
    def test_manual_index_change_blocks_overwrite(self):
        result=tool.sync(self.vault,True);index=Path(result['target'])/'AJTool - Continuidad.md'
        index.write_text('Human edit')
        with self.assertRaisesRegex(ValueError,'index changed'):tool.sync(self.vault,True)
        self.assertEqual(index.read_text(),'Human edit')
    def test_snapshot_change_blocks_overwrite(self):
        result=tool.sync(self.vault,True);note=Path(result['target'])/result['version']/'CURRENT.md'
        note.write_text('Human edit')
        with self.assertRaisesRegex(ValueError,'Snapshot conflict'):tool.sync(self.vault,True)
        self.assertEqual(note.read_text(),'Human edit')
    def test_secrets_and_private_evidence_are_rejected(self):
        with self.assertRaises(ValueError):tool.record('Codex','DECIDED','password=never-store-this',['docs/continuity/state.json'])
        private=self.root/'.env.local';private.write_text('private')
        with self.assertRaises(ValueError):tool.record('Codex','DECIDED','A change',['.env.local'])
    def test_missing_evidence_is_rejected(self):
        with self.assertRaises(ValueError):tool.record('Codex','VERIFIED_LOCAL','A change',['missing.json'])

if __name__=='__main__':unittest.main()
