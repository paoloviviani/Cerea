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
already available, go straight to them. Its place searches use public servers run by volunteers, which
are sometimes slow or busy; the rest (addresses, routes) uses other services and is usually quick.

## Places nearby ("parking near…", "cafés around…", "a pharmacy open now")

1. **First: `find_nearby_pois`, once.** Search by category, or by an OpenStreetMap tag when the request is
   specific (cuisine, diet, wheelchair access, a brand). It can take up to a minute when the servers are busy;
   give it that time.
2. **If it fails or times out, do not call it again** (not with another radius, category or tag): the tool
   already tries every configured server before it gives up, so a second call only adds another minute of
   waiting. Go straight to **a web search** for "<what> near <place>", and read the results' own pages for
   addresses, hours and prices. For parking, include the operator sites and the city's parking pages. Say in
   a few words that the map search didn't answer.
3. **For the rest of the conversation**, once a place search has failed, skip the tools that need it
   (`find_nearby_pois`, `poi_details`, `suggest_meeting_point`) and use web search for places. Try them again
   only if the person asks.

A search that answered but found few places is not a failure: report what it found, and widen the radius
once only if the person wants more.

For a place's details (opening hours, phone, website), use `poi_details`. If it fails, use the place's own
website from a web search.

When sources disagree, prefer what the place's own website says.

## Addresses and coordinates

Use `geocode` (a name or an address to a place) and `reverse_geocode` (coordinates to an address).

## Routes and travel times

- **A route between two or more points:** `route`, on foot, by car or by bike.
- **Times from many origins to many destinations:** `route_matrix`.
- **The best order to visit several stops:** `optimize_route`.
- **What's reachable within a time or distance** ("within 15 minutes' walk"): `isochrone`.
- **A fair meeting point for a group:** `suggest_meeting_point`. If it fails (it needs the place search),
  compute travel times with `route_matrix` and pick a place found by a web search that balances them.
- **Straight-line distance and map links:** `straight_line_distance` and `map_link` (offline, always
  available). End answers about a place or a route with a `map_link` when it helps.

## Rules

- Map data is edited by anyone and can be out of date. Present opening hours and phone numbers as "listed
  as", and suggest checking before travelling when it matters.
- Never show raw coordinates unless asked. Give names, addresses and a map link.
