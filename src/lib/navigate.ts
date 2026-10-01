/** Full-page navigation (e.g. to an OAuth provider). A module of its own so tests can replace it. */
export const redirectTo = (url: string): void => {
  window.location.assign(url);
};
