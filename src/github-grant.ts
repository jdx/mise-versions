// Deleting an OAuth App grant revokes every token the user has issued to the
// app, and makes GitHub show the consent screen again on the next sign-in
// (which is how a user gets a token with fewer scopes than before).
export async function revokeGrant(
  credentials: { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string },
  accessToken: string,
): Promise<boolean> {
  const { GITHUB_CLIENT_ID: id, GITHUB_CLIENT_SECRET: secret } = credentials;
  const response = await fetch(
    `https://api.github.com/applications/${id}/grant`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "mise-versions",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  await response.body?.cancel();
  // 404 means the grant is already gone, which is what we wanted.
  return response.status === 204 || response.status === 404;
}
