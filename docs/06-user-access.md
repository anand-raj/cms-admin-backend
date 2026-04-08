# 06 — User Access

## How Access Works

Sveltia CMS has no internal user database or admin panel. Access to the CMS is controlled entirely by **GitHub repository permissions** — whoever has write access to the repo can log into the CMS.

## Granting CMS Access

1. Go to the repository: `https://github.com/anand-raj/cms-hugo-decap`
2. Navigate to **Settings → Collaborators → Add people**
3. Search for the user's GitHub username or email
4. Click **Add collaborator**
5. Set their role to **Write** (minimum required to save content)

The user will receive a GitHub invitation email. Once accepted, they can log in.

## Logging In (New User)

1. Visit `https://anand-raj.github.io/cms-hugo-decap/admin/`
2. Click **Login with GitHub**
3. Authorize the **Sveltia CMS** OAuth App on their GitHub account
4. They are redirected back to the CMS dashboard and can create/edit content immediately

## Revoking Access

1. Go to **Settings → Collaborators**
2. Find the user → click **Remove**

Their existing OAuth token becomes useless — they can no longer write to the repo, so the CMS rejects all save attempts.

## Role Reference

| GitHub Role | Can log in to CMS | Can publish content | Can change repo settings |
|---|---|---|---|
| Read | No | No | No |
| Write | Yes | Yes | No |
| Maintain | Yes | Yes | Limited |
| Admin | Yes | Yes | Yes |

Write is the appropriate role for content editors who should not have access to repository settings.

## Notes

- Users authorize the OAuth App on their **own** GitHub account — you do not share credentials
- The OAuth App is registered under your account; collaborators just use it to authenticate
- If a user sees `access_denied` during OAuth, verify their collaborator invitation was accepted
