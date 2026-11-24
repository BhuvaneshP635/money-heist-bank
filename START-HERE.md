# Bank owner patch

Use this ZIP to prepare your own bank's Firebase project and publish its GitHub Pages portal. Use Node.js 22 or newer, Git and GitHub CLI. The SharedDB admin handles the central registry and Cloudflare.

## 1. Send your bank details

Edit `owner.json` with your bank name, GitHub username, and test customer's email. If you already own a Firebase project, add its exact ID as `firebaseProjectId`. If the admin already assigned your bank an ID, add it as `assignedBankId` and use the exact name from the central directory. Optionally set `githubRepo` if your existing repository has a different name. Send `owner.json` to the SharedDB admin. Keep any passwords out of the JSON.

For GK-BANK the existing assignment uses `GK-BANK`, `gopikrishnan-ajith`, `firebaseProjectId` of `gkbank-5ffd5`, and `assignedBankId` of `P659`. Use the test email previously submitted for the reservation.

The admin returns a file named like `bank-P659.json`. Use that file for the remaining stages. The commands below use P659 as the example.

## 2. Prepare Firebase in your bank's Google Cloud Shell

Upload this ZIP and the assigned JSON to your bank project's Cloud Shell. Extract the ZIP, open the extracted folder, and put `bank-P659.json` beside `bank.sh`.

```bash
bash bank.sh prepare bank-P659.json
```

If the assigned Google Cloud project has yet to be created and your account can create projects, add `--create-project`. The first run links Firebase and prepares the default Firestore database. Once the Firebase project exists, enable **Authentication → Get started → Sign-in method → Email/Password → Enable → Save** in that bank's Firebase Console. The script prints the project-specific link if this step is needed. Standard Firebase Email/Password sign-in works without enabling billing. Leave Email link sign-in off for this portal.

Run the same prepare command again after saving the provider. It reuses the default database and existing test user and balance. It prompts for a password when creating the test user. Keep the password for your portal test. If the Firestore IAM grant fails, have the bank project administrator grant the SharedDB Worker identity `roles/datastore.user` on the bank's project, then rerun prepare.

After success, download the registration file in your bank Cloud Shell and send it to the SharedDB admin:

```bash
cloudshell download x42-registration-P659.json
```

Use the printed filename for your bank. Keep the test account number and IFSC from the output for the transfer test.

## 3. Publish your portal

From the extracted patch folder in your Cloud Shell or in Git Bash on your PC, sign in to GitHub CLI as the repository owner or maintainer. Then publish:

```bash
gh auth login
gh auth setup-git
bash bank.sh portal bank-P659.json --publish --wait
```

The script creates a public repo if missing, builds the branded portal, enables GitHub Actions as the Pages source, and watches the deployment. For an existing private repository, your plan must support Pages for that repo. If a previous version already deployed your portal, you can give the existing URL to the SharedDB admin. To refresh the title and link preview, run the publish command with this patch. Use `--workspace DIRECTORY` to point to an existing parent directory containing the cloned repository, such as the earlier package's `x42-portals`.

If an older checkout stopped at `src/amount.js: new blank line at EOF` with only the generated portal changes staged, open that repo, remove the extra newline and commit the generated changes:

```bash
sed -i '${/^[[:blank:]]*$/d;}' src/amount.js
git add src/amount.js
git diff --cached --check && git commit -m "Configure SharedBank portal"
```

Return to the patch folder and rerun publish with `--workspace` pointing to that checkout's parent. The new template already includes the whitespace fix.

## 4. Confirm with the SharedDB admin

Send the published URL and the registration JSON. After the admin activates the bank, open the portal and sign in with your test customer's email and password. Ask the admin to send a synthetic ₹1 from Nexus or Lyra to your test account and check that your portal shows one ₹1 credit.
