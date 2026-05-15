# Testing

## Backend

Typical checks:

- `pytest`
- `ruff check`
- `basedpyright`

Focus on regression coverage for:

- transaction validation and normalization
- doctor issue generation
- pad computation
- importer config validation and execution
- API error translation and payload shape

## Google Sheets Client

Typical checks:

- `npm run check`
- `npm test`

Focus on regression coverage for:

- sheet sync behavior
- edit and save reconstruction behavior
- quick-add and sheet settings interactions
- importer dialog behavior

## Documentation Changes

For documentation-only changes, run the tests most likely to catch drift in the areas you touched rather than treating docs as unverified prose.
