/**
 * Whether the code sandbox may install packages from the public PyPI index.
 *
 * On by default: a user who never touched the setting (`undefined`) is on, an
 * explicitly stored `false` is off, and the administrator's switch
 * (`CHAT_PYODIDE_PYPI_DISABLED`, reported as `allowed: false`) overrides both.
 */
export function pypiInstallEffective(allowed: unknown, stored: boolean | undefined): boolean {
	return allowed === true && stored !== false;
}
