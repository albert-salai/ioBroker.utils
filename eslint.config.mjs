import eslint       from '@eslint/js';
import tseslint     from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
			"dist/",
			"eslint.config.mjs"
        ]
    },
    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['eslint.config.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern:  '^_',
                varsIgnorePattern:  '^_',
                caughtErrors:       'none',
            }],
        },
    },
);
