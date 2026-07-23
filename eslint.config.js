import path from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	// Sonar-style code smells (cognitive complexity, duplicated branches,
	// collapsible ifs...) linted locally, no SonarCloud needed.
	sonarjs.configs.recommended,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint recommends not to use no-undef on TS projects.
			'no-undef': 'off',
			// Allow _-prefixed params/vars as intentional "unused" markers.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			]
		}
	},
	{
		// sonarjs adoption baseline. A library keeps most rules ON; only the
		// conflicts with this codebase's deliberate idioms are disabled.
		// Weakening any of these further needs human approval, with the
		// rationale written here.
		rules: {
			// New code stays under 25; grandfather legacy hotspots per file at the
			// bottom of this config - that list only shrinks.
			'sonarjs/cognitive-complexity': ['error', 25],
			// Redundant with @typescript-eslint/no-unused-vars above, but without
			// the _-prefix escape hatch.
			'sonarjs/no-unused-vars': 'off',
			// Dense conditional style is idiomatic here; revisit per module.
			'sonarjs/no-nested-conditional': 'off',
			'sonarjs/no-nested-assignment': 'off',
			// `void somePromise` is the documented fire-and-forget marker.
			'sonarjs/void-use': 'off',
			// The invitation/manifest codecs parse the user's OWN data client
			// side; worst-case backtracking is not a serving-path concern.
			'sonarjs/super-linear-regex': 'off',
			// Math.random is only used for non-security jitter; key material
			// goes through crypto.getRandomValues.
			'sonarjs/pseudo-random': 'off',
			// These two contradict each other on documented one-off unions vs
			// aliases; naming stays a judgment call.
			'sonarjs/use-type-alias': 'off',
			'sonarjs/redundant-type-aliases': 'off'
		}
	},
	{
		// Test files: fixtures and stubs trip rules meant for production code.
		files: ['**/*.test.ts'],
		rules: {
			// A crypto library's tests hard-code passphrases by nature.
			'sonarjs/no-hardcoded-passwords': 'off',
			// Assertions often live in shared helpers (until(), round-trips).
			'sonarjs/assertions-in-tests': 'off',
			'sonarjs/prefer-specific-assertions': 'off',
			// Stub closures write flags that static analysis cannot follow.
			'no-useless-assignment': 'off',
			// Fixture objects capture the suite's `this` on purpose.
			'@typescript-eslint/no-this-alias': 'off'
		}
	},
	// Grandfathered complexity hotspots (their current score, frozen).
	// Refactor one, tighten or delete its line. Never add an entry.
	{
		files: ['src/widgets/backups.ts'],
		rules: { 'sonarjs/cognitive-complexity': ['error', 63] }
	},
	{
		files: ['src/widgets/connect.ts'],
		rules: { 'sonarjs/cognitive-complexity': ['error', 49] }
	},
	{
		files: ['src/persistence/store.ts', 'src/households/group.ts'],
		rules: { 'sonarjs/cognitive-complexity': ['error', 47] }
	},
	{
		files: ['src/widgets/share.ts'],
		rules: { 'sonarjs/cognitive-complexity': ['error', 42] }
	},
	{
		files: ['src/sync/merge.ts'],
		rules: { 'sonarjs/cognitive-complexity': ['error', 32] }
	},
	// Formatting belongs to prettier; drop every stylistic rule so the two
	// tools never fight. Must stay last.
	prettier
);
