# Why vercel.json turns git deployments off

The GitHub integration for this repo pointed at Vercel project ianiboyai/ctp-core,
which is NOT the live site and failed to build on every push from 9 Sep 2026.
The live https://ctpcore.vercel.app is project ctp-core under account
ian-33be3d61 (Root Directory = app). Deploy it from the REPO ROOT:

    npx vercel deploy --prod --scope ian-33be3d61

The root .vercelignore uploads only app/ (not Quotes/ or the cost workbooks).
(The explanation used to live in vercel.json as "$comment"; Vercel CLI 64 rejects
unknown keys, so it moved here on 2026-10-19.)
