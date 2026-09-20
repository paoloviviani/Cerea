#!/usr/bin/env bash
#
# envfile.sh — deploy/.env parsing and templating.
#
# The .env contract is line-oriented: one variable, one line, no
# continuations (the signing key travels as a file, never an inline PEM).
# Both directions live here and are pure: read a fragment file, emit text;
# read a .env, fill PARSED. No docker, no prompts, no writes. Unit-tested
# by installer/tests/test-envfile.sh.
#
# State:
#   PARSED / PARSED_ORDER   last parsed .env: key -> value (quotes stripped,
#                           legacy multi-line PEMs assembled), first-seen order
#   INSTALLER_META          last parsed .env's installer-metadata block, when
#                           it carries one: INSTALLER_* -> value, read
#                           verbatim on resume (META_PRESENT = 1 when the
#                           block was found). INSTALLER_* keys never enter
#                           PARSED: they are not deployment values, and the
#                           resume copy into VALUES must never carry them
#
# Functions (inputs -> outputs):
#   build_env_file <fragment-path>  -> the assembled .env on stdout: the
#                                       fragment's lines pass through, keys
#                                       present in VALUES are replaced in
#                                       place, keys the fragment never had are
#                                       appended under an installer section,
#                                       and — when the shape globals are set
#                                       (PROFILE + EXPOSURE) — the installer
#                                       metadata block closes the file
#   parse_env_file <path>           -> PARSED/PARSED_ORDER from KEY=VALUE lines
#                                       (comments reset continuation, one layer
#                                       of matching quotes stripped) plus
#                                       INSTALLER_META from the metadata block
#   reset_parsed_state              -> PARSED / INSTALLER_META cleared (a fresh
#                                       run must not inherit a peeked .env's
#                                       values as prompt defaults)

# Filled by parse_env_file; declared here so `${PARSED[key]:-}` is safe
# before the first parse (fresh installs never parse anything).
declare -A PARSED=()
PARSED_ORDER=()
declare -A INSTALLER_META=()
META_PRESENT=0

reset_parsed_state() {
	PARSED_ORDER=()
	declare -gA PARSED=()
	declare -gA INSTALLER_META=()
	META_PRESENT=0
}

# The metadata block: delimited, commented, single-line values — compose
# reads the file as a plain env-file and ignores every INSTALLER_* name.
# Values come from the shape globals (values.sh): the same state that drove
# the .env values, so block and values cannot drift within one install.
installer_metadata_lines() { # installer_metadata_lines (block on stdout)
	local idp_word auth_mode_word components_spec
	idp_word="$(installer_idp_word)"
	auth_mode_word="$(installer_auth_mode_word)"
	shape_to_components
	components_spec="$COMPONENTS_SPEC"
	printf '%s\n' "# >>> installer metadata >>>"
	printf '%s\n' "# Written by installer/install.sh at install time and read verbatim by"
	printf '%s\n' "# --phase2 (and by flagged fresh runs, for contradiction checks). The"
	printf '%s\n' "# vocabulary is versioned: INSTALLER_VERSION bumps when the shape"
	printf '%s\n' "# semantics change. Edit only together with the values it describes."
	printf 'INSTALLER_VERSION=%s\n' "$INSTALLER_META_VERSION"
	printf 'INSTALLER_PROFILE=%s\n' "$PROFILE"
	printf 'INSTALLER_EXPOSURE=%s\n' "$EXPOSURE"
	printf 'INSTALLER_IDP=%s\n' "$idp_word"
	printf 'INSTALLER_AUTH_MODE=%s\n' "$auth_mode_word"
	printf 'INSTALLER_COMPONENTS=%s\n' "$components_spec"
	printf '%s\n' "# <<< installer metadata <<<"
}

# The fragment stays the single source of defaults: its lines (comments
# included) pass through, overridden keys are replaced in place, and keys
# the fragment never had are appended under an installer section. With every
# value single-line this is one pass with no continuation tracking — the
# multi-line span rule the node installer carried existed for exactly one
# variable (the inline signing PEM), and the key is a file now.
build_env_file() { # build_env_file <fragment-path>  (env content on stdout)
	local fragment="$1" line key
	declare -A SEEN=()
	while IFS= read -r line || [ -n "$line" ]; do
		key=""
		case "$line" in
			[A-Za-z_]*=*)
				key="${line%%=*}"
				if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -n "${VALUES[$key]+x}" ]; then
					SEEN[$key]=1
					printf '%s=%s\n' "$key" "${VALUES[$key]}"
					continue
				fi
				;;
		esac
		printf '%s\n' "$line"
	done <"$fragment"
	local missing=0 key2
	for key2 in "${VALUES_ORDER[@]}"; do
		if [ -z "${SEEN[$key2]+x}" ]; then
			if [ "$missing" = "0" ]; then
				printf '\n'
				printf '# --- installer additions ------------------------------------------------------\n'
				printf '# Values for toggles this fragment never had (a deviated component choice),\n'
				printf '# or names the fragment predates: the IdP signing key travels as a file, and\n'
				printf '# the standalone profiles carry parse-only gateway secrets (no gateway runs\n'
				printf '# on these profiles, but the base compose file refuses to interpolate\n'
				printf '# without them — even `docker compose logs` would fail against this .env).\n'
				missing=1
			fi
			printf '%s=%s\n' "$key2" "${VALUES[$key2]}"
		fi
	done
	# The metadata block closes the file — but only when a real install
	# shape is in play. Lib-only callers (and the unit tests) leave PROFILE
	# unset and get exactly the pre-metadata output.
	if [ -n "${PROFILE:-}" ] && [ -n "${EXPOSURE:-}" ]; then
		printf '\n'
		installer_metadata_lines
	fi
}

# Parse KEY=VALUE lines back (resume only; the file is never rewritten from
# this). Blank lines, comments and a stray multi-line PEM (a legacy file
# from before the key became a path) are handled: continuation lines attach
# to the current key, and a PEM END marker belongs to the value and closes
# it. One layer of matching surrounding quotes is stripped, so a hand-edited
# USE_USER_TOKEN="true" is read the way compose would read it.
#
# The installer-metadata block (delimited by the >>> / <<< marker lines) is
# lifted out into INSTALLER_META as it is parsed: the keys are read
# verbatim — no quote stripping, no continuation, no defaults — and they
# never reach PARSED, so a resume copy into VALUES cannot mistake installer
# bookkeeping for deployment values.
parse_env_file() { # parse_env_file <path>
	local line trimmed current="" key value in_meta=0 probe
	reset_parsed_state
	while IFS= read -r line || [ -n "$line" ]; do
		trimmed="${line#"${line%%[![:space:]]*}"}"
		probe="${trimmed%"${trimmed##*[![:space:]]}"}"
		case "$probe" in
			"# >>> installer metadata >>>")
				[ "$in_meta" = "0" ] || fail "$1: a second '>>> installer metadata >>>' marker inside the metadata block."
				in_meta=1
				META_PRESENT=1
				current=""
				continue
				;;
			"# <<< installer metadata <<<")
				[ "$in_meta" = "1" ] || fail "$1: '<<< installer metadata <<<' without its opening marker."
				in_meta=0
				current=""
				continue
				;;
		esac
		if [ "$in_meta" = "1" ]; then
			case "$probe" in
				"" | \#*) continue ;;
			esac
			case "$trimmed" in
				[A-Za-z_]*=*)
					key="${trimmed%%=*}"
					value="${trimmed#*=}"
					case "$key" in
						INSTALLER_[A-Z_]*) ;;
						*) fail "$1: unexpected key '$key' inside the installer metadata block (INSTALLER_* only)." ;;
					esac
					[ -n "${INSTALLER_META[$key]+x}" ] && fail "$1: '$key' appears twice inside the installer metadata block."
					INSTALLER_META[$key]="$value"
					;;
				*)
					fail "$1: unexpected line inside the installer metadata block: $trimmed"
					;;
			esac
			continue
		fi
		case "$trimmed" in
			"" | \#*)
				current=""
				continue
				;;
		esac
		if [[ "$trimmed" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
			current="${BASH_REMATCH[1]}"
			# INSTALLER_* outside the block is bookkeeping, not a deployment
			# value — skip it either way.
			case "$current" in
				INSTALLER_*) current="" ;;
			esac
			[ -n "$current" ] || continue
			value="${BASH_REMATCH[2]}"
			if [ -z "${PARSED[$current]+x}" ]; then PARSED_ORDER+=("$current"); fi
			PARSED[$current]="$value"
		elif [ -n "$current" ]; then
			case "$trimmed" in
				-----END*)
					PARSED[$current]+=$'\n'"$trimmed"
					current=""
					;;
				*)
					PARSED[$current]+=$'\n'"$trimmed"
					;;
			esac
		else
			current=""
		fi
	done <"$1"
	# Quote stripping, after the fact so continuation assembly is raw.
	local key2
	for key2 in "${PARSED_ORDER[@]}"; do
		value="${PARSED[$key2]}"
		if [ "${#value}" -ge 2 ]; then
			case "$value" in
				\"*\" | \'*\')
					value="${value:1:${#value}-2}"
					PARSED[$key2]="$value"
					;;
			esac
		fi
	done
}
