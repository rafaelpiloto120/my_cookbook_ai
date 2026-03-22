Test fixtures for the file/app import flow.

Valid files:
- `valid-html-schema.html`
- `valid-html-fallback.html`
- `valid-recipes.csv`
- `valid-myrecipebox.rtk`
- `valid-paprika.paprikarecipes`
- `valid-recipe-backup.zip`

Invalid files:
- `invalid-unsupported.txt`
- `invalid-missing-columns.csv`
- `invalid-corrupted.zip`

The three archive files are generated from simple JSON fixtures so the current parser can exercise
the ZIP-based import path without needing real exports from third-party apps.
