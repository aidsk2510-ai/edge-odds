// Home venues for weather lookups: team name -> [latitude, longitude, roof]
// roof: 'outdoor' | 'dome' (fixed roof, always indoors) | 'retractable'
// Coordinates only need to be city-level accurate for a weather forecast.
// Team names are matched loosely (accents, "FC", "CF" etc. ignored), so either
// "Atlético Madrid" or "Atletico Madrid" works. Add teams here as needed.

export const INDOOR_SPORTS = new Set(['basketball_nba', 'basketball_ncaab', 'basketball_wnba', 'icehockey_nhl', 'mma_mixed_martial_arts']);

const O = 'outdoor', D = 'dome', R = 'retractable';

const NFL = {
  'Arizona Cardinals': [33.528, -112.263, R], 'Atlanta Falcons': [33.755, -84.401, R], 'Baltimore Ravens': [39.278, -76.623, O],
  'Buffalo Bills': [42.774, -78.787, O], 'Carolina Panthers': [35.226, -80.853, O], 'Chicago Bears': [41.862, -87.617, O],
  'Cincinnati Bengals': [39.095, -84.516, O], 'Cleveland Browns': [41.506, -81.700, O], 'Dallas Cowboys': [32.748, -97.093, R],
  'Denver Broncos': [39.744, -105.020, O], 'Detroit Lions': [42.340, -83.046, D], 'Green Bay Packers': [44.501, -88.062, O],
  'Houston Texans': [29.685, -95.411, R], 'Indianapolis Colts': [39.760, -86.164, R], 'Jacksonville Jaguars': [30.324, -81.637, O],
  'Kansas City Chiefs': [39.049, -94.484, O], 'Las Vegas Raiders': [36.091, -115.184, D], 'Los Angeles Chargers': [33.953, -118.339, D],
  'Los Angeles Rams': [33.953, -118.339, D], 'Miami Dolphins': [25.958, -80.239, O], 'Minnesota Vikings': [44.974, -93.258, D],
  'New England Patriots': [42.091, -71.264, O], 'New Orleans Saints': [29.951, -90.081, D], 'New York Giants': [40.813, -74.074, O],
  'New York Jets': [40.813, -74.074, O], 'Philadelphia Eagles': [39.901, -75.168, O], 'Pittsburgh Steelers': [40.447, -80.016, O],
  'San Francisco 49ers': [37.403, -121.970, O], 'Seattle Seahawks': [47.595, -122.332, O], 'Tampa Bay Buccaneers': [27.976, -82.503, O],
  'Tennessee Titans': [36.166, -86.771, O], 'Washington Commanders': [38.908, -76.864, O],
};

const MLB = {
  'Arizona Diamondbacks': [33.445, -112.067, R], 'Atlanta Braves': [33.891, -84.468, O], 'Baltimore Orioles': [39.284, -76.622, O],
  'Boston Red Sox': [42.346, -71.097, O], 'Chicago Cubs': [41.948, -87.656, O], 'Chicago White Sox': [41.830, -87.634, O],
  'Cincinnati Reds': [39.097, -84.507, O], 'Cleveland Guardians': [41.496, -81.685, O], 'Colorado Rockies': [39.756, -104.994, O],
  'Detroit Tigers': [42.339, -83.049, O], 'Houston Astros': [29.757, -95.355, R], 'Kansas City Royals': [39.051, -94.480, O],
  'Los Angeles Angels': [33.800, -117.883, O], 'Los Angeles Dodgers': [34.074, -118.240, O], 'Miami Marlins': [25.778, -80.220, R],
  'Milwaukee Brewers': [43.028, -87.971, R], 'Minnesota Twins': [44.982, -93.278, O], 'New York Mets': [40.757, -73.846, O],
  'New York Yankees': [40.829, -73.926, O], 'Athletics': [38.580, -121.514, O], 'Oakland Athletics': [38.580, -121.514, O],
  'Philadelphia Phillies': [39.906, -75.166, O], 'Pittsburgh Pirates': [40.447, -80.006, O], 'San Diego Padres': [32.707, -117.157, O],
  'San Francisco Giants': [37.778, -122.389, O], 'Seattle Mariners': [47.591, -122.332, R], 'St. Louis Cardinals': [38.622, -90.193, O],
  'Tampa Bay Rays': [27.768, -82.653, D], 'Texas Rangers': [32.747, -97.084, R], 'Toronto Blue Jays': [43.641, -79.389, R],
  'Washington Nationals': [38.873, -77.007, O],
};

const MLS = {
  'Atlanta United': [33.755, -84.401, R], 'Austin': [30.388, -97.720, O], 'CF Montreal': [45.563, -73.553, O],
  'Charlotte': [35.226, -80.853, O], 'Chicago Fire': [41.862, -87.617, O], 'Colorado Rapids': [39.806, -104.892, O],
  'Columbus Crew': [39.968, -83.017, O], 'DC United': [38.868, -77.013, O], 'Cincinnati': [39.111, -84.522, O],
  'Dallas': [33.154, -96.835, O], 'Houston Dynamo': [29.752, -95.352, O], 'Inter Miami': [25.790, -80.250, O],
  'LA Galaxy': [33.864, -118.261, O], 'Los Angeles': [34.013, -118.284, O], 'Minnesota United': [44.953, -93.165, O],
  'Nashville': [36.130, -86.766, O], 'New England Revolution': [42.091, -71.264, O], 'New York City': [40.829, -73.926, O],
  'New York Red Bulls': [40.737, -74.150, O], 'Orlando City': [28.541, -81.389, O], 'Philadelphia Union': [39.832, -75.378, O],
  'Portland Timbers': [45.521, -122.692, O], 'Real Salt Lake': [40.583, -111.893, O], 'San Diego': [32.784, -117.120, O],
  'San Jose Earthquakes': [37.351, -121.925, O], 'Seattle Sounders': [47.595, -122.332, O], 'Sporting Kansas City': [39.122, -94.823, O],
  'St. Louis City': [38.631, -90.211, O], 'St Louis City': [38.631, -90.211, O], 'Toronto': [43.633, -79.418, O],
  'Vancouver Whitecaps': [49.277, -123.112, R],
};

const EUROPE = {
  // England
  'Arsenal': [51.555, -0.108, O], 'Aston Villa': [52.509, -1.885, O], 'Bournemouth': [50.735, -1.838, O], 'Brentford': [51.491, -0.289, O],
  'Brighton and Hove Albion': [50.862, -0.083, O], 'Burnley': [53.789, -2.230, O], 'Chelsea': [51.482, -0.191, O], 'Crystal Palace': [51.398, -0.086, O],
  'Everton': [53.425, -3.003, O], 'Fulham': [51.475, -0.222, O], 'Ipswich Town': [52.055, 1.145, O], 'Leeds United': [53.778, -1.572, O],
  'Leicester City': [52.620, -1.142, O], 'Liverpool': [53.431, -2.961, O], 'Manchester City': [53.483, -2.200, O], 'Manchester United': [53.463, -2.291, O],
  'Newcastle United': [54.976, -1.622, O], 'Nottingham Forest': [52.940, -1.133, O], 'Southampton': [50.906, -1.391, O], 'Sunderland': [54.915, -1.388, O],
  'Tottenham Hotspur': [51.604, -0.066, O], 'West Ham United': [51.539, -0.017, O], 'Wolverhampton Wanderers': [52.590, -2.130, O],
  'Sheffield United': [53.370, -1.471, O], 'Luton Town': [51.884, -0.432, O], 'Middlesbrough': [54.578, -1.217, O], 'Coventry City': [52.448, -1.496, O],
  'Norwich City': [52.622, 1.309, O], 'Watford': [51.650, -0.402, O], 'West Bromwich Albion': [52.509, -1.964, O],
  // Spain
  'Real Madrid': [40.453, -3.688, R], 'Barcelona': [41.381, 2.123, O], 'Atletico Madrid': [40.436, -3.600, O], 'Athletic Bilbao': [43.264, -2.949, O],
  'Real Sociedad': [43.301, -1.974, O], 'Real Betis': [37.356, -5.982, O], 'Sevilla': [37.384, -5.971, O], 'Villarreal': [39.944, -0.104, O],
  'Valencia': [39.475, -0.358, O], 'Girona': [41.961, 2.829, O], 'Celta Vigo': [42.212, -8.740, O], 'Osasuna': [42.797, -1.637, O],
  'Getafe': [40.326, -3.715, O], 'Rayo Vallecano': [40.392, -3.659, O], 'Mallorca': [39.590, 2.630, O], 'Alaves': [42.837, -2.688, O],
  'Espanyol': [41.348, 2.076, O], 'Las Palmas': [28.100, -15.457, O], 'Leganes': [40.340, -3.760, O], 'Real Valladolid': [41.645, -4.761, O],
  'Levante': [39.495, -0.364, O], 'Elche': [38.267, -0.663, O], 'Real Oviedo': [43.361, -5.870, O], 'Cadiz': [36.502, -6.273, O],
  'Granada': [37.153, -3.596, O], 'Almeria': [36.840, -2.435, O],
  // Rest of Europe (Champions League regulars)
  'Bayern Munich': [48.219, 11.625, O], 'Borussia Dortmund': [51.493, 7.452, O], 'Bayer Leverkusen': [51.038, 7.002, O], 'RB Leipzig': [51.346, 12.348, O],
  'Eintracht Frankfurt': [50.069, 8.645, O], 'VfB Stuttgart': [48.792, 9.232, O], 'Inter Milan': [45.478, 9.124, O], 'Inter': [45.478, 9.124, O],
  'AC Milan': [45.478, 9.124, O], 'Juventus': [45.110, 7.641, O], 'Napoli': [40.828, 14.193, O], 'Atalanta': [45.709, 9.681, O],
  'AS Roma': [41.934, 12.455, O], 'Roma': [41.934, 12.455, O], 'Lazio': [41.934, 12.455, O], 'Bologna': [44.492, 11.310, O],
  'Paris Saint Germain': [48.841, 2.253, O], 'Monaco': [43.728, 7.416, O], 'Marseille': [43.270, 5.396, O], 'Lille': [50.612, 3.130, R],
  'Lyon': [45.765, 4.982, O], 'Benfica': [38.753, -9.185, O], 'Porto': [41.162, -8.584, O], 'Sporting Lisbon': [38.761, -9.161, O],
  'Sporting CP': [38.761, -9.161, O], 'Ajax': [52.314, 4.942, R], 'PSV Eindhoven': [51.442, 5.467, O], 'Feyenoord': [51.894, 4.523, O],
  'Celtic': [55.850, -4.206, O], 'Club Brugge': [51.193, 3.181, O], 'Galatasaray': [41.103, 28.991, O], 'Slavia Prague': [50.068, 14.471, O],
  'Olympiacos': [37.946, 23.664, O], 'Copenhagen': [55.703, 12.572, O], 'Union Saint Gilloise': [50.818, 4.329, O], 'Bodo Glimt': [67.276, 14.383, O],
};

const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'cd', 'ca', 'ac', 'ud', 'rcd', 'club', 'de', 'the']);
export const normalize = (name) => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\u00f8/g, 'o').replace(/\u00e6/g, 'ae').replace(/\u00df/g, 'ss')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter((w) => w && !STOP.has(w)).join(' ');

const TABLES = { americanfootball_nfl: NFL, baseball_mlb: MLB, soccer_usa_mls: MLS };
const index = (obj) => new Map(Object.entries(obj).map(([k, v]) => [normalize(k), v]));
const INDEXED = Object.fromEntries(Object.entries(TABLES).map(([s, t]) => [s, index(t)]));
const EUROPE_INDEX = index(EUROPE);

// Returns [lat, lon, roof] for the home team, or null if we don't know the venue.
export function venueFor(sport, homeTeam) {
  const key = normalize(homeTeam);
  if (sport.startsWith('soccer_') && sport !== 'soccer_usa_mls') return EUROPE_INDEX.get(key) || null;
  return INDEXED[sport]?.get(key) || null;
}
