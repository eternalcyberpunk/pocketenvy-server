import os
os.environ["REQUIRE_NVENC"] = "0"
import json, subprocess, sys, tempfile, unittest, zipfile, stat
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"worker"))
import media
import project_task
OPTIONS = dict(format="mp4",codec="h264",quality=80,resolution="source",aspectRatio="source",targetFps=0,
    interpolate=False,upscale=1,denoise=False,sharpen=False,retentionDays=7)
COMP = dict(id=1,name="Test",width=64,height=48,pixelAspect=1,fps=24,duration=1)
class MediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name);cls.source=cls.root/"source.mov"
        subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","testsrc2=size=64x48:rate=24:duration=1",
          "-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","png","-threads","1","-c:a","pcm_s16le",str(cls.source)],check=True)
    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()
    def test_actual_outputs_and_audio(self):
        for fmt,codec in [("mp4","h264"),("mov","prores"),("webm","vp9"),("png_sequence","png")]:
            with self.subTest(format=fmt), tempfile.TemporaryDirectory() as temp:
                options={**OPTIONS,"format":fmt,"codec":codec,"aspectRatio":"1:1","upscale":2,"targetFps":30,"denoise":True,"sharpen":True}
                output,mime,details=media.finish(self.source,Path(temp),dict(comp=COMP,options=options))
                self.assertTrue(output.is_file());self.assertEqual(details["output"],dict(width=96,height=96,fps=30))
                if fmt=="png_sequence":
                    with zipfile.ZipFile(output) as archive:
                        self.assertEqual(sum(n.endswith(".png") for n in archive.namelist()),30)
                        self.assertIn("audio.wav",archive.namelist())
                        self.assertEqual(json.loads(archive.read("sequence.json"))["fps"],30)
                else:
                    actual=media.probe(output);self.assertTrue(actual["audio"])
                    self.assertEqual((actual["width"],actual["height"]),(96,96))
                    self.assertAlmostEqual(actual["fps"],30,places=2)
                    self.assertLess(abs(actual["duration"]-1),.1)
    def test_interpolation_keeps_duration(self):
        with tempfile.TemporaryDirectory() as temp:
            output,_,_=media.finish(self.source,Path(temp),dict(comp=COMP,options={**OPTIONS,"targetFps":60,"interpolate":True}))
            actual=media.probe(output);self.assertAlmostEqual(actual["fps"],60)
            self.assertLess(abs(actual["duration"]-1),.05)
    def test_master_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError,"does not match"):
                media.finish(self.source,Path(temp),dict(comp={**COMP,"width":128},options=OPTIONS))
    def test_storage_allowlist_and_encoder_contract(self):
        os.environ["STORAGE_HOSTS"]="storage.example.test"
        self.assertEqual(media.storage_url("https://storage.example.test/bucket/file"),"https://storage.example.test/bucket/file")
        for url in ["http://storage.example.test/a","https://evil.test/a","https://user:pass@storage.example.test/a"]:
            with self.assertRaises(ValueError): media.storage_url(url)
        os.environ["REQUIRE_NVENC"]="1"
        try:
            self.assertEqual(media.encoding("av1",80)[1],"av1_nvenc")
            self.assertEqual(media.encoding("hevc",80)[1],"hevc_nvenc")
        finally: os.environ["REQUIRE_NVENC"]="0"
    def test_package_traversal_and_symlink(self):
        for name,link in [("../outside",False),("C:/outside",False),("safe",True),("COM9.txt",False)]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);src=root/"package.zip"
                with zipfile.ZipFile(src,"w") as archive:
                    info=zipfile.ZipInfo(name)
                    if link: info.external_attr=(stat.S_IFLNK|0o777)<<16
                    archive.writestr(info,"unsafe")
                with self.assertRaises(ValueError): project_task.extract_package(src,root/"out")
    def test_valid_project_and_relinker_literal(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);src=root/"package.zip";dest=root/"out"
            manifest=dict(version=2,project="project.aep",assets=[dict(itemId=4,role="proxy",sequence=True,useProxy=True,packagedPath="assets/a0001.png")])
            with zipfile.ZipFile(src,"w") as archive:
                archive.writestr("project.aep","mock project");archive.writestr("assets/a0001.png","mock frame")
                archive.writestr("pocketenvy-manifest.json",json.dumps(manifest))
            loaded=project_task.extract_package(src,dest)
            script,_,_=project_task.relinker(dest,loaded,dict(comp={**COMP,"name":'ASSETS"; app.quit(); //'}))
            code=script.read_text()
            self.assertIn('ASSETS\\"; app.quit(); //',code)
            self.assertIn("setProxyWithSequence",code)
            self.assertNotIn("var assets=ASSETS",code)
if __name__=="__main__": unittest.main()
