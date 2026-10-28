---
name: maps-routing-geoapify
description: >
  Use the map connectors (Geoapify and OpenStreetMap) for places, addresses, routes and travel times,
  with web search as the fallback for places. Use whenever the person asks where something is, what is
  nearby, how to get somewhere, how long it takes, or where to meet.
---

# Maps: places, addresses and routes

Two map connectors may be available. Use whichever is there; with both, follow the split below.

- **Geoapify** (its tools: `search_places`, `list_place_categories`, `geocode_address`,
  `reverse_geocode_coordinates`, `calculate_route`, `calculate_route_matrix` and four geometry tools).
  A commercial service: fast and reliable, and every call costs the deployment credits.
- **OpenStreetMap** (named osm in the kit's example; its tools: `find_nearby_pois`, `poi_details`,
  `geocode`, `route`, `route_matrix`, `optimize_route`, `isochrone`, `suggest_meeting_point`, `map_link`
  and others). Free. Use it for addresses, routes and travel times, which are quick. **Don't use its place
  tools** (`find_nearby_pois`, `poi_details`, `suggest_meeting_point`): they depend on public volunteer servers
  that, in practice, time out almost every time.

**Recognise the connectors by their address or tools, not their name:** an administrator may call them
anything ("Find locations", "Maps"). Geoapify is the one at `api.geoapify.com`, or the one offering
`search_places`; OpenStreetMap is the one offering `find_nearby_pois`. If a connector's line gives no tools
and you can't tell what it is, load it with `load_tools` and look at what it offers.

If a connector's tools are not available yet, load it with `load_tools` by the name the catalogue gives
it; if they are already available, go straight to them. Load only what the question needs.

## Who does what

| Question | First choice | If it fails |
|---|---|---|
| Places nearby by type ("pharmacies near…") | Geoapify `search_places` | web search |
| Places with an attribute (vegan, wheelchair access, free Wi-Fi, a brand) | Geoapify by the closest category, then check each place's own website | web search |
| A place's opening hours, phone, website | the place's own website, from a web search | — |
| An address or a place name to coordinates | Geoapify `geocode_address` | OSM `geocode` |
| Coordinates to an address | Geoapify `reverse_geocode_coordinates` | OSM `reverse_geocode` |
| A route, A to B (and via stops) | OSM `route` | Geoapify `calculate_route` |
| Travel times, many to many | OSM `route_matrix` | Geoapify `calculate_route_matrix` (costly: about sources × targets credits) |
| Best order for several stops | OSM `optimize_route` | — |
| What's reachable within a time ("15 minutes' walk") | OSM `isochrone` | — |
| A fair meeting point | travel times with OSM `route_matrix`, then a place near the best point from `search_places` | — |
| Inside an area? Buffers, areas, lengths | Geoapify geometry tools | — |
| A link to show the place or route | OSM `map_link` with coordinates you already have | — |

Ask one service, not both, for the same thing. Use the second only when the first fails or can't answer.

## Geoapify places: choosing a category

`search_places` takes **one** category, a centre (`lat`, `lon`), and optionally `radius_meters` and
`limit` (1 to 100, default 20). It needs coordinates: geocode the place first if you only have a name.
It has no filters for attributes (diet, access, Wi-Fi) or names: search the closest category, then check the
places' own websites, or use a web search.

Categories are dot-separated paths from general to specific; a parent includes all its children:
`catering` ⊃ `catering.restaurant` ⊃ `catering.restaurant.pizza`. Only the exact values Geoapify supports
work; never invent one.

1. **Use the most specific category you're sure of.** Common ones:

   | The person asks for | Category |
   |---|---|
   | restaurant / a cuisine | `catering.restaurant`, `catering.restaurant.<cuisine>` (pizza, sushi, italian, chinese, indian, thai…) |
   | café, bar, pub, fast food, ice cream | `catering.cafe`, `catering.bar`, `catering.pub`, `catering.fast_food`, `catering.ice_cream` |
   | supermarket, corner shop, shopping centre | `commercial.supermarket`, `commercial.convenience`, `commercial.shopping_mall` |
   | pharmacy, hospital, doctor, dentist | `healthcare.pharmacy`, `healthcare.hospital`, `healthcare.clinic_or_praxis`, `healthcare.dentist` |
   | hotel, hostel, guest house | `accommodation.hotel`, `accommodation.hostel`, `accommodation.guest_house` |
   | car park, bike parking | `parking.cars`, `parking.bicycles` (also `parking.cars.underground`, `parking.cars.multistorey`) |
   | EV charging, fuel, car wash | `service.vehicle.charging_station`, `service.vehicle.fuel`, `service.vehicle.car_wash` |
   | cash machine, post office, police | `service.financial.atm`, `service.post.office`, `service.police` |
   | bus, train, tram, metro stop | `public_transport.bus`, `public_transport.train`, `public_transport.tram`, `public_transport.subway` |
   | sights, museum, cinema, zoo | `tourism.sights`, `tourism.attraction`, `entertainment.museum`, `entertainment.cinema`, `entertainment.zoo` |
   | park, playground | `leisure.park`, `leisure.playground` |
   | gym, swimming pool | `sport.fitness`, `sport.swimming_pool` |
   | school, university, library | `education.school`, `education.university`, `education.library` |
   | toilet, drinking water | `amenity.toilet`, `amenity.drinking_water` |
   | vet, pet shop, dog park | `pet.veterinary`, `pet.shop`, `pet.dog_park` |
   | bike or car rental | `rental.bicycle`, `rental.car` |

2. **Not sure of the value?** Call `list_place_categories` **once per conversation**, keep the list, and
   pick from it: find the segment that matches the request ("charging_station"), then take its full path.
3. **An error saying the category is not supported:** look it up in the list and retry once with the
   right value. Don't guess a second time.
4. **No results:** go up one level (`catering.restaurant.vegan` → `catering.restaurant`), or widen the
   radius once, and say you did. A few results is an answer, not a failure.
5. **A broad request** ("somewhere to eat"): at most two searches (`catering.restaurant` and
   `catering.fast_food`), not every child category.
6. **Keep it cheap.** Each search costs at least 1 credit, plus 1 per 20 places returned. Keep `limit` at
   20 or less unless the person wants a long list, and don't repeat a search that already answered.

## OpenStreetMap's place tools: don't

`find_nearby_pois`, `poi_details` and `suggest_meeting_point` need the public Overpass servers, which in
practice time out almost every time, after up to a minute of waiting. Don't call them, not even as a
fallback. Use Geoapify for places, and a web search for what it can't answer, reading the results' own
pages for addresses, hours and prices. Call them only if the person asks for them by name.

## Rules

- Map data can be out of date. Give opening hours and phone numbers as "listed as", and suggest checking
  before travelling when it matters. When sources disagree, prefer the place's own website.
- **A named venue** (restaurant, shop, museum): find its address with a web search or its own website
  first, then geocode the address. Don't geocode the venue's name.
- Don't cross-check one service's coordinates with the other unless the results conflict.
- **`map_link`:** pass coordinates you already have (`"lat,lon"`), never names: it geocodes names itself and
  can land on the wrong spot. One link per answer is usually enough.
- Give names, addresses and distances; never raw coordinates unless asked. Use the same coordinates for
  the distances and the link; if the address only resolved to its street, say so.
- Say which distance you mean: walking (from `route`) or straight-line, never both unlabelled.
- Geometry tools take GeoJSON in `[longitude, latitude]` order; routing and place tools take `lat` and
  `lon` separately. Don't swap them.
