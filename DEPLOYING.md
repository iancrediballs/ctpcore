# Deploying the web app

```
cd C:\Users\Administrator\Desktop\CTP\ctpcore-portable
npx.cmd vercel --prod
```

**From the repository root, not from `app/`.** The live project `ctp-core`
(account `ian-33be3d61`) has **Root Directory = `app`** in its settings, so it
expects to be handed the repo and to find the app inside it. Running the
command from `app/` makes Vercel look for `app/app` and fail with
*"The specified Root Directory 'app' does not exist"* — which is what happened
on 26 Sep 2026, and the older note in `vercel.json` telling you to `cd app`
first was simply wrong.

Two other things that bit on the same morning, both now fixed but worth knowing:

- **`vercel.json` cannot carry comments.** It used to hold a `$comment` key
  explaining all this, and the CLI refuses to deploy with it present
  (*"should NOT have additional property `$comment`"*). That explanation is why
  this file exists. Leave `vercel.json` as the two lines it now is.
- **`Error: Not authorized` means relink, not re-login.** On 7 Oct 2026 the
  deploy failed with that and nothing else, while `npx.cmd vercel whoami` still
  answered `00iamian00`. The fix was one command — it refreshes the link and the
  OIDC token the CLI deploys with:

  ```
  npx.cmd vercel link --yes --project ctp-core --scope ian-33be3d61
  ```

  Don't log out first; you'll just have to log back in and the error will still
  be there. (It writes `.env.local`, which holds a short-lived token. `.env*` is
  gitignored, so it stays out of commits — leave it that way.)
- **Running the command in an unlinked directory creates a new project.**
  `vercel --prod --yes` in a folder with no `.vercel/` will happily invent a
  project named after the folder and deploy there instead of to the live site —
  silently, because it looks like a success. If you are ever unsure what you
  are deploying to, `.vercel/project.json` names it.

Git deployments are off on purpose (`git.deploymentEnabled: false`). There is a
separate GitHub-linked Vercel project, `ianiboyai/ctp-core`, which is **not** the
live site and has failed to build on every push since 9 September 2026 because
its own Root Directory is unset. Delete it or set its Root Directory to `app`;
until then, ignore its failure emails.

## Checking the deploy actually landed

The bundle filenames are content-hashed, so comparing them before and after is
the cheapest honest proof:

```
curl -s https://ctpcore.vercel.app | findstr assets/
```
