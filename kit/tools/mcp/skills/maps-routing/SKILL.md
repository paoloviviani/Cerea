---
name: maps-routing
description: >
  Use the OpenStreetMap tools for places, addresses, routes and travel times, with web search as the
  fallback for places. Use whenever the person asks where something is, what is nearby, how to get
  somewhere, how long it takes, or where to meet.
---

# Maps: places, addresses and routes

The OpenStreetMap connector answers map questions. If its tools are not available yet, load the
OpenStreetMap connector first with `load_tools` (it is named osm in the kit's example); if they are
already available, go straight to them. Use it for addresses, routes and travel times, which are quick.
**Don't use its place tools** (`find_nearby_pois`, `poi_details`, `suggest_meeting_point`): they depend on
public volunteer servers (Overpass) that, in practice, time out almost every time.

## Places nearby ("parking near…", "cafés around…", "a pharmacy open now")

Use **a web search** for "<what> near <place>", and read the results' own pages for addresses, hours and
prices. For parking, include the operator sites and the city's parking pages. Then use `geocode` and `route`
or `route_matrix` for distances and walking times, and end with one `map_link` built from those coordinates.

Don't call `find_nearby_pois` or `poi_details`, not even once to try: they wait up to a minute and then fail.
Call them only if the person asks for them by name.

When sources disagree, prefer what the place's own website says.

## Addresses and coordinates

Use `geocode` (a name or an address to a place) and `reverse_geocode` (coordinates to an address).

## Routes and travel times

- **A route between two or more points:** `route`, on foot, by car or by bike.
- **Times from many origins to many destinations:** `route_matrix`.
- **The best order to visit several stops:** `optimize_route`.
- **What's reachable within a time or distance** ("within 15 minutes' walk"): `isochrone`.
- **A fair meeting point for a group:** compute travel times with `route_matrix`, and pick a place found by
  a web search that balances them (not `suggest_meeting_point`, which needs the place search).
- **Straight-line distance and map links:** `straight_line_distance`, and `map_link` with coordinates you
  already have (`"lat,lon"`), never names: it geocodes names itself and can land on the wrong spot. One
  link per answer is usually enough.

## Rules

- Map data is edited by anyone and can be out of date. Present opening hours and phone numbers as "listed
  as", and suggest checking before travelling when it matters.
- **A named venue** (restaurant, shop, museum): find its address with a web search or its own website
  first, then `geocode` the address. Don't geocode the venue's name.
- Never show raw coordinates unless asked. Give names, addresses and a map link, using the same
  coordinates as the distances.
- Say which distance you mean: walking (from `route`) or straight-line, never both unlabelled.
