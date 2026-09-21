"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {estimateSchema,geometry}=require("../lib/options");
const {quote,actualCreditUnits}=require("../lib/credits");
const comp={id:1,name:"Test",width:1920,height:1080,fps:24,duration:60,pixelAspect:1};
const options={format:"mp4",codec:"h264",quality:80,resolution:"source",aspectRatio:"source",targetFps:0,interpolate:false,upscale:1,denoise:false,sharpen:false,retentionDays:1};
const base={workflow:"CLOUD_FINISH",computeTier:"STANDARD",comp,options};
test("invalid containers, excessive upscale, and ineffective interpolation are rejected",()=>{
  for(const changes of [{format:"webm"},{upscale:4,resolution:"2160p"},{interpolate:true}])
    assert.equal(estimateSchema.safeParse({...base,options:{...options,...changes}}).success,false);
  assert.equal(estimateSchema.safeParse({...base,workflow:"FULL_PROJECT",options:{...options,format:"png_sequence",codec:"png"}}).success,true);
});
test("aspect, resolution, upscale and pixel aspect determine final dimensions",()=>{
  assert.deepEqual(geometry(comp,{...options,aspectRatio:"9:16",resolution:"720p",upscale:2,targetFps:60}),{width:1440,height:2560,fps:60});
  assert.deepEqual(geometry({...comp,width:720,height:480,pixelAspect:1.2},options),{width:864,height:480,fps:24});
});
test("reservation includes output workload, service tier and retention",()=>{
  const normal=quote(comp,options,{});
  assert.ok(quote(comp,{...options,upscale:2},{}).reservedCreditUnits>normal.reservedCreditUnits);
  assert.ok(quote(comp,{...options,computeTier:"TURBO"},{}).reservedCreditUnits>normal.reservedCreditUnits);
  assert.equal(quote(comp,{...options,retentionDays:30},{}).reservedCreditUnits-normal.reservedCreditUnits,290);
});
test("settlement uses saved prices and can never exceed the reservation",()=>{
  const q=quote(comp,options,{});
  assert.equal(actualCreditUnits(60000000,q.reservedCreditUnits,q.pricing),q.reservedCreditUnits);
  assert.equal(actualCreditUnits(1,q.reservedCreditUnits,q.pricing),250);
});
test("unconfigured administrative credentials and sessions fail closed",()=>{
  const auth=require("../lib/auth");assert.equal(auth.safeEqual("",""),false);assert.equal(auth.safeEqual("short","short"),false);
  assert.throws(()=>auth.verifySession("invalid"));
});
test("malformed render-node URL is unavailable",()=>{
  const providers=require("../lib/providers");
  process.env.ENABLE_FULL_PROJECT="true";process.env.AE_FARM_API_KEY="x".repeat(40);process.env.AE_FARM_BASE_URL="bad-url";
  assert.equal(providers.route("FULL_PROJECT","STANDARD"),null);
});
