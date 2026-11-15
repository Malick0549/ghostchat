# GhostChat: owner checklist (things only you can do)

Do these in order. Each step says where to click and how to know it worked.

## 1. Revoke the leaked Gmail app password (do first, 5 min)
1. Open https://myaccount.google.com/apppasswords (sign in).
2. Find the app password used for GhostChat and click the bin icon to delete it.
3. Check https://myaccount.google.com/notifications for anything you don't recognise.
4. Remove the old value from Render > your service > Environment (MAIL_PASSWORD or similar). Never paste it in chat or code again.
Done when: the old password no longer appears in the list.

## 2. Make email work reliably (admins cannot log in without it)
Admin 2FA, verification and password reset all rely on email.
Fast route (works today): SendGrid > Settings > Sender Authentication > "Verify a single sender", use an address you own, create an API key (Mail Send only).
Better route (professional): buy a domain, then in SendGrid or Resend choose "Authenticate your domain" and add the SPF/DKIM DNS records they show. Wait until they show Verified.
On Render > Environment set the variables your app already reads for mail (see docs/OPERATIONS.md): the API key/SMTP login, MAIL_FROM (e.g. no-reply@yourdomain), and RESET_URL_BASE = https://ghostchat-t0cp.onrender.com (or your domain).
Test: register a new user, confirm the verification email arrives (check spam), then use Forgot password.
Safety net: if email breaks and an admin is locked out, set ADMIN_2FA_REQUIRED=0 on Render, log in, fix email, then remove the variable.

## 3. Set TRUSTED_PROXY_HOPS (so IP logs and rate limits are right)
1. Log in as admin > Security tab. Look at the IP shown for your own login.
2. If it shows a Render-internal address (10.x / 172.x) rather than your real public IP, set TRUSTED_PROXY_HOPS=1 on Render and redeploy.
3. Check again: it should now show your real IP (compare at https://whatismyip.com).
Done when: your real IP and location appear in the admin audit log.

## 4. Legal
- Confirm the contact email in frontend/js/legal-config.js is the one you read daily.
- Have a Ghana lawyer review Terms and Privacy. Ask specifically about registering with the Data Protection Commission (Data Protection Act, 2012, Act 843), retention periods, and your liability as operator of an encrypted messaging service.
- After review, update the text (build_legal.py output) and bump TERMS_VERSION so users re-accept.

## 5. Real-phone test (30 min, two phones, two accounts)
1. Sign up on phone A and B; verify emails arrive.
2. Forgot password on A: link works once, second use fails.
3. A messages B: text, photo, voice note, document. Both sides read them.
4. Check the safety number matches on both phones, tap verify.
5. Create a group, add a third person, send a message.
6. Settings > Move keys: move A's keys to a second device, enter the recovery passphrase, confirm old device shows the "moved" screen.
7. Set auto-lock to 1 minute, wait, confirm unlock asks for the passphrase.
8. Install the app (Add to Home Screen), turn on airplane mode, open it: offline page appears.
9. Log in as admin: code arrives by email, audit log shows locations and devices.
Write down anything odd and send it to me.

## 6. Render and database
- Free plan sleeps after inactivity: first load can take ~50s. Consider the paid plan before promoting widely.
- Neon free tier: check backups/point-in-time restore in the Neon console.
- Keep SECRET_KEY and DATABASE_URL only in Render environment.

## 7. Before announcing publicly
Steps 1, 2, 4 (at least lawyer booked) and 5 complete. Then post the share messages and video.
