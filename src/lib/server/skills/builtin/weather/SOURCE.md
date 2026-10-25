# Source

- **Origin:** written for Cerea by its maintainer; no upstream. Licensed with
  the repository (Apache-2.0).

## Notes

- Works through the chat's own `web_fetch` tool: no bundled scripts, no
  container, no API key.
- Open-Meteo (https://open-meteo.com) is free for non-commercial use; the
  skill tells the model to mention the subscription when someone needs it for
  a business. wttr.in is used only as a one-line check.
- Hourly replies are parallel lists; the skill asks the model to pair each
  value with its `time[i]` and to trim with `forecast_hours`, which keeps
  smaller models from shifting rows.
