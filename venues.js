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
  // More English clubs (promotion candidates)
  'Millwall': [51.486, -0.051, O], 'Hull City': [53.746, -0.368, O], 'Stoke City': [52.988, -2.176, O], 'Preston North End': [53.772, -2.688, O],
  'Bristol City': [51.440, -2.620, O], 'Wrexham': [53.052, -3.004, O], 'Derby County': [52.915, -1.447, O], 'Blackburn Rovers': [53.729, -2.489, O],
  'Sheffield Wednesday': [53.411, -1.501, O], 'Queens Park Rangers': [51.509, -0.232, O], 'Swansea City': [51.643, -3.935, O], 'Cardiff City': [51.473, -3.203, O],
  'Portsmouth': [50.796, -1.064, O], 'Oxford United': [51.716, -1.208, O], 'Plymouth Argyle': [50.388, -4.151, O], 'Birmingham City': [52.476, -1.868, O],
  'Charlton Athletic': [51.486, 0.037, O],
  // More Spanish clubs
  'Racing Santander': [43.476, -3.794, O], 'Deportivo La Coruna': [43.369, -8.417, O], 'Sporting Gijon': [43.536, -5.637, O], 'Real Zaragoza': [41.637, -0.902, O],
  'Eibar': [43.181, -2.476, O], 'Huesca': [42.131, -0.420, O], 'Malaga': [36.734, -4.426, O], 'Burgos': [42.345, -3.688, O], 'Albacete': [38.990, -1.855, O],
  'Cordoba': [37.873, -4.762, O], 'Castellon': [39.994, -0.042, O], 'Mirandes': [42.684, -2.947, O],
  // More European clubs
  'Fenerbahce': [40.988, 29.037, O], 'Besiktas': [41.039, 29.002, O], 'Sparta Prague': [50.100, 14.416, O], 'Viktoria Plzen': [49.750, 13.386, O],
  'Red Star Belgrade': [44.783, 20.465, O], 'Crvena Zvezda': [44.783, 20.465, O], 'Dinamo Zagreb': [45.819, 16.018, O], 'Red Bull Salzburg': [47.816, 12.998, O],
  'Salzburg': [47.816, 12.998, O], 'Sturm Graz': [47.046, 15.455, O], 'Young Boys': [46.963, 7.465, O], 'Basel': [47.541, 7.620, O],
  'Rangers': [55.853, -4.309, O], 'Anderlecht': [50.834, 4.298, O], 'Genk': [51.005, 5.533, O], 'Midtjylland': [56.116, 8.952, O],
  'Malmo FF': [55.584, 12.988, O], 'Malmo': [55.584, 12.988, O], 'Ferencvaros': [47.481, 19.098, O], 'Qarabag': [40.430, 49.920, O],
  'Kairat Almaty': [43.237, 76.946, O], 'Pafos': [34.775, 32.424, O], 'Shakhtar Donetsk': [50.068, 19.948, O], 'Slovan Bratislava': [48.163, 17.137, O],
  'Lens': [50.433, 2.815, O], 'Nice': [43.705, 7.193, O], 'Brest': [48.403, -4.462, O], 'Stade Brestois': [48.403, -4.462, O],
  'AZ Alkmaar': [52.613, 4.742, O], 'Twente': [52.237, 6.837, O], 'Freiburg': [48.022, 7.830, O], 'Hoffenheim': [49.239, 8.888, O],
  'Mainz': [49.984, 8.224, O], 'Wolfsburg': [52.432, 10.804, O], 'Borussia Monchengladbach': [51.175, 6.385, O], 'Union Berlin': [52.457, 13.568, O],
  'Fiorentina': [43.781, 11.282, O], 'Torino': [45.042, 7.650, O], 'Como': [45.814, 9.072, O], 'Braga': [41.563, -8.430, O],
  'Olympique Lyonnais': [45.765, 4.982, O], 'Olympique Marseille': [43.270, 5.396, O], 'PSG': [48.841, 2.253, O], 'Paris SG': [48.841, 2.253, O],
};

// College football (all FBS programs, plus FCS). Keys are school names; mascots are ignored when matching,
// so "Ohio State Buckeyes" and "Ohio State" both find "Ohio State".
const NCAAF = {
  // ACC
  'Boston College': [42.335, -71.166, O], 'California': [37.871, -122.251, O], 'Cal': [37.871, -122.251, O], 'Clemson': [34.679, -82.843, O],
  'Duke': [35.995, -78.942, O], 'Florida State': [30.438, -84.304, O], 'Georgia Tech': [33.773, -84.393, O], 'Louisville': [38.206, -85.759, O],
  'Miami': [25.958, -80.239, O], 'Miami FL': [25.958, -80.239, O], 'NC State': [35.800, -78.720, O], 'North Carolina State': [35.800, -78.720, O],
  'North Carolina': [35.907, -79.048, O], 'Pittsburgh': [40.447, -80.016, O], 'Pitt': [40.447, -80.016, O], 'SMU': [32.837, -96.783, O],
  'Southern Methodist': [32.837, -96.783, O], 'Stanford': [37.434, -122.161, O], 'Syracuse': [43.036, -76.136, D], 'Virginia': [38.031, -78.514, O],
  'Virginia Tech': [37.220, -80.418, O], 'Wake Forest': [36.130, -80.256, O],
  // Big Ten
  'Illinois': [40.099, -88.236, O], 'Indiana': [39.181, -86.526, O], 'Iowa': [41.659, -91.551, O], 'Maryland': [38.990, -76.947, O],
  'Michigan': [42.266, -83.749, O], 'Michigan State': [42.728, -84.485, O], 'Minnesota': [44.977, -93.225, O], 'Nebraska': [40.821, -96.706, O],
  'Northwestern': [42.065, -87.692, O], 'Ohio State': [40.002, -83.020, O], 'Oregon': [44.058, -123.068, O], 'Penn State': [40.812, -77.856, O],
  'Purdue': [40.435, -86.919, O], 'Rutgers': [40.514, -74.465, O], 'UCLA': [34.161, -118.168, O], 'USC': [34.014, -118.288, O],
  'Southern California': [34.014, -118.288, O], 'Washington': [47.650, -122.302, O], 'Wisconsin': [43.070, -89.413, O],
  // Big 12
  'Arizona': [32.229, -110.949, O], 'Arizona State': [33.426, -111.933, O], 'Baylor': [31.558, -97.116, O], 'BYU': [40.257, -111.655, O],
  'Brigham Young': [40.257, -111.655, O], 'Cincinnati': [39.131, -84.516, O], 'Colorado': [40.009, -105.267, O], 'Houston': [29.722, -95.349, O],
  'Iowa State': [42.014, -93.636, O], 'Kansas': [38.963, -95.246, O], 'Kansas State': [39.202, -96.594, O], 'Oklahoma State': [36.126, -97.067, O],
  'TCU': [32.710, -97.368, O], 'Texas Christian': [32.710, -97.368, O], 'Texas Tech': [33.591, -101.873, O], 'UCF': [28.608, -81.193, O],
  'Central Florida': [28.608, -81.193, O], 'Utah': [40.760, -111.849, O], 'West Virginia': [39.650, -79.955, O],
  // SEC
  'Alabama': [33.208, -87.550, O], 'Arkansas': [36.068, -94.179, O], 'Auburn': [32.602, -85.489, O], 'Florida': [29.650, -82.349, O],
  'Georgia': [33.950, -83.373, O], 'Kentucky': [38.022, -84.505, O], 'LSU': [30.412, -91.184, O], 'Louisiana State': [30.412, -91.184, O],
  'Ole Miss': [34.362, -89.534, O], 'Mississippi': [34.362, -89.534, O], 'Mississippi State': [33.456, -88.794, O], 'Missouri': [38.936, -92.333, O],
  'Oklahoma': [35.206, -97.443, O], 'South Carolina': [33.973, -81.019, O], 'Tennessee': [35.955, -83.925, O], 'Texas': [30.284, -97.733, O],
  'Texas A&M': [30.610, -96.340, O], 'Vanderbilt': [36.144, -86.809, O],
  // Pac-12
  'Oregon State': [44.560, -123.281, O], 'Washington State': [46.732, -117.161, O], 'Boise State': [43.603, -116.196, O],
  'Colorado State': [40.571, -105.089, O], 'Fresno State': [36.814, -119.758, O], 'San Diego State': [32.783, -117.122, O],
  'Utah State': [41.752, -111.812, O], 'Texas State': [29.891, -97.925, O],
  // American
  'Army': [41.388, -73.964, O], 'Charlotte': [35.310, -80.741, O], 'East Carolina': [35.597, -77.366, O], 'Florida Atlantic': [26.373, -80.101, O],
  'FAU': [26.373, -80.101, O], 'Memphis': [35.121, -89.977, O], 'Navy': [38.985, -76.507, O], 'North Texas': [33.204, -97.159, O],
  'Rice': [29.716, -95.409, O], 'South Florida': [27.976, -82.503, O], 'USF': [27.976, -82.503, O], 'Temple': [39.901, -75.168, O],
  'Tulane': [29.943, -90.117, O], 'Tulsa': [36.149, -95.945, O], 'UAB': [33.502, -86.809, O], 'UTSA': [29.417, -98.479, D],
  // Conference USA
  'Delaware': [39.660, -75.749, O], 'FIU': [25.753, -80.379, O], 'Florida International': [25.753, -80.379, O],
  'Jacksonville State': [33.820, -85.766, O], 'Kennesaw State': [34.030, -84.582, O], 'Liberty': [37.355, -79.177, O],
  'Louisiana Tech': [32.531, -92.649, O], 'Middle Tennessee': [35.849, -86.367, O], 'Middle Tennessee State': [35.849, -86.367, O],
  'Missouri State': [37.199, -93.280, O], 'New Mexico State': [32.280, -106.746, O], 'Sam Houston': [30.715, -95.546, O],
  'Sam Houston State': [30.715, -95.546, O], 'UTEP': [31.773, -106.509, O], 'Western Kentucky': [36.985, -86.459, O], 'WKU': [36.985, -86.459, O],
  // MAC
  'Akron': [41.072, -81.508, O], 'Ball State': [40.215, -85.411, O], 'Bowling Green': [41.378, -83.629, O], 'Buffalo': [43.000, -78.778, O],
  'Central Michigan': [43.578, -84.771, O], 'Eastern Michigan': [42.250, -83.638, O], 'Kent State': [41.144, -81.338, O],
  'Miami OH': [39.512, -84.744, O], 'Miami Ohio': [39.512, -84.744, O], 'Northern Illinois': [41.934, -88.778, O], 'Ohio': [39.322, -82.105, O],
  'Toledo': [41.658, -83.616, O], 'Western Michigan': [42.283, -85.613, O], 'Massachusetts': [42.377, -72.537, O], 'UMass': [42.377, -72.537, O],
  // Mountain West
  'Air Force': [38.997, -104.844, O], 'Hawaii': [21.298, -157.818, O], 'Hawai i': [21.298, -157.818, O], 'Nevada': [39.546, -119.817, O],
  'New Mexico': [35.067, -106.629, O], 'San Jose State': [37.320, -121.868, O], 'UNLV': [36.091, -115.184, D], 'Wyoming': [41.313, -105.568, O],
  // Sun Belt
  'Appalachian State': [36.211, -81.686, O], 'App State': [36.211, -81.686, O], 'Arkansas State': [35.849, -90.668, O],
  'Coastal Carolina': [33.794, -79.016, O], 'Georgia Southern': [32.411, -81.784, O], 'Georgia State': [33.735, -84.389, O],
  'James Madison': [38.435, -78.873, O], 'Louisiana': [30.213, -92.042, O], 'Louisiana Lafayette': [30.213, -92.042, O],
  'Louisiana Monroe': [32.531, -92.078, O], 'UL Monroe': [32.531, -92.078, O], 'ULM': [32.531, -92.078, O], 'Marshall': [38.425, -82.421, O],
  'Old Dominion': [36.887, -76.306, O], 'South Alabama': [30.696, -88.178, O], 'Southern Miss': [31.329, -89.334, O],
  'Southern Mississippi': [31.329, -89.334, O], 'Troy': [31.800, -85.954, O],
  // Independents
  'Notre Dame': [41.698, -86.234, O], 'UConn': [41.759, -72.619, O], 'Connecticut': [41.759, -72.619, O], 'Sacramento State': [38.561, -121.424, O],
  // FCS
  'Cal Poly': [35.300, -120.660, O], 'Eastern Washington': [47.491, -117.584, O], 'Idaho': [46.727, -117.014, D], 'Idaho State': [42.861, -112.432, D],
  'Montana': [46.861, -113.985, O], 'Montana State': [45.667, -111.050, O], 'Northern Arizona': [35.181, -111.655, D], 'Northern Colorado': [40.404, -104.698, O],
  'Portland State': [45.521, -122.692, O], 'UC Davis': [38.537, -121.756, O], 'Weber State': [41.192, -111.937, O],
  'Illinois State': [40.510, -88.993, O], 'Indiana State': [39.468, -87.411, O], 'Murray State': [36.616, -88.320, O], 'North Dakota': [47.921, -97.088, D],
  'North Dakota State': [46.900, -96.801, D], 'Northern Iowa': [42.514, -92.462, D], 'South Dakota': [42.788, -96.925, D], 'South Dakota State': [44.312, -96.798, O],
  'Southern Illinois': [37.710, -89.218, O], 'Youngstown State': [41.105, -80.649, O],
  'Albany': [42.686, -73.823, O], 'Bryant': [41.923, -71.540, O], 'Campbell': [35.405, -78.738, O], 'Elon': [36.103, -79.503, O], 'Hampton': [37.022, -76.336, O],
  'Maine': [44.902, -68.672, O], 'Monmouth': [40.280, -74.005, O], 'New Hampshire': [43.138, -70.937, O], 'North Carolina A&T': [36.075, -79.772, O],
  'Rhode Island': [41.486, -71.531, O], 'Richmond': [37.575, -77.540, O], 'Stony Brook': [40.912, -73.123, O], 'Towson': [39.393, -76.611, O],
  'Villanova': [40.034, -75.338, O], 'William & Mary': [37.272, -76.715, O],
  'Chattanooga': [35.046, -85.309, O], 'East Tennessee State': [36.303, -82.370, O], 'ETSU': [36.303, -82.370, O], 'Furman': [34.925, -82.439, O],
  'Mercer': [32.829, -83.649, O], 'Samford': [33.464, -86.793, O], 'Citadel': [32.797, -79.961, O], 'VMI': [37.790, -79.442, O],
  'Western Carolina': [35.308, -83.186, O], 'Wofford': [34.958, -81.935, O],
  'Houston Christian': [29.695, -95.515, O], 'Incarnate Word': [29.468, -98.467, O], 'Lamar': [30.040, -94.074, O], 'McNeese': [30.180, -93.218, O],
  'McNeese State': [30.180, -93.218, O], 'Nicholls': [29.791, -90.803, O], 'Nicholls State': [29.791, -90.803, O], 'Northwestern State': [31.749, -93.098, O],
  'Southeastern Louisiana': [30.515, -90.468, O], 'East Texas A&M': [33.243, -95.907, O], 'Texas A&M Commerce': [33.243, -95.907, O],
  'Stephen F Austin': [31.620, -94.649, O], 'UTRGV': [26.306, -98.174, O], 'Texas Rio Grande Valley': [26.306, -98.174, O],
  'Abilene Christian': [32.468, -99.708, O], 'Austin Peay': [36.534, -87.354, O], 'Central Arkansas': [35.078, -92.459, O], 'Eastern Kentucky': [37.736, -84.296, O],
  'North Alabama': [34.808, -87.680, O], 'Southern Utah': [37.676, -113.069, O], 'Tarleton State': [32.217, -98.217, O], 'Tarleton': [32.217, -98.217, O],
  'Utah Tech': [37.104, -113.565, O], 'West Georgia': [33.573, -85.101, O],
  'Charleston Southern': [32.981, -80.071, O], 'Eastern Illinois': [39.482, -88.175, O], 'Gardner Webb': [35.248, -81.669, O], 'Lindenwood': [38.787, -90.502, O],
  'Southeast Missouri State': [37.315, -89.531, O], 'SE Missouri State': [37.315, -89.531, O], 'Tennessee State': [36.167, -86.831, O],
  'Tennessee Tech': [36.175, -85.505, O], 'UT Martin': [36.342, -88.865, O], 'Tennessee Martin': [36.342, -88.865, O], 'Western Illinois': [40.471, -90.685, O],
  'Bucknell': [40.955, -76.884, O], 'Colgate': [42.818, -75.538, O], 'Fordham': [40.861, -73.886, O], 'Georgetown': [38.907, -77.072, O],
  'Holy Cross': [42.238, -71.808, O], 'Lafayette': [40.698, -75.210, O], 'Lehigh': [40.606, -75.378, O],
  'Brown': [41.830, -71.403, O], 'Columbia': [40.872, -73.914, O], 'Cornell': [42.447, -76.477, O], 'Dartmouth': [43.702, -72.289, O],
  'Harvard': [42.367, -71.127, O], 'Penn': [39.950, -75.190, O], 'Pennsylvania': [39.950, -75.190, O], 'Princeton': [40.346, -74.656, O], 'Yale': [41.313, -72.960, O],
  'Alabama A&M': [34.783, -86.574, O], 'Alabama State': [32.364, -86.296, O], 'Alcorn State': [31.876, -91.135, O], 'Arkansas Pine Bluff': [34.243, -92.010, O],
  'Bethune Cookman': [29.211, -81.033, O], 'Florida A&M': [30.425, -84.287, O], 'Grambling': [32.525, -92.716, O], 'Grambling State': [32.525, -92.716, O],
  'Jackson State': [32.296, -90.208, O], 'Mississippi Valley State': [33.497, -90.329, O], 'Prairie View': [30.091, -95.987, O], 'Prairie View A&M': [30.091, -95.987, O],
  'Southern': [30.524, -91.191, O], 'Southern University': [30.524, -91.191, O], 'Texas Southern': [29.722, -95.360, O],
  'Delaware State': [39.186, -75.543, O], 'Howard': [38.922, -77.020, O], 'Morgan State': [39.343, -76.584, O], 'Norfolk State': [36.848, -76.262, O],
  'North Carolina Central': [35.975, -78.898, O], 'South Carolina State': [33.497, -80.849, O],
  'Butler': [39.840, -86.170, O], 'Davidson': [35.501, -80.846, O], 'Dayton': [39.740, -84.180, O], 'Drake': [41.602, -93.656, O], 'Marist': [41.722, -73.934, O],
  'Morehead State': [38.187, -83.433, O], 'Presbyterian': [34.471, -81.877, O], 'San Diego': [32.772, -117.188, O], 'St Thomas': [44.942, -93.190, O],
  'Stetson': [29.034, -81.303, O], 'Valparaiso': [41.463, -87.044, O],
  'Central Connecticut': [41.692, -72.765, O], 'Central Connecticut State': [41.692, -72.765, O], 'Duquesne': [40.436, -79.990, O], 'LIU': [40.690, -73.981, O],
  'Long Island': [40.690, -73.981, O], 'Mercyhurst': [42.104, -80.045, O], 'Robert Morris': [40.520, -80.180, O], 'Saint Francis': [40.507, -78.641, O],
  'St Francis PA': [40.507, -78.641, O], 'Stonehill': [42.058, -71.080, O], 'Wagner': [40.614, -74.093, O], 'New Haven': [41.290, -72.962, O],
  'Merrimack': [42.668, -71.122, O], 'Sacred Heart': [41.221, -73.243, O],
};

const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'cd', 'ca', 'ac', 'ud', 'rcd', 'club', 'de', 'the', 'fk', 'sk', 'bk', 'nk', 'gnk', 'ssc', 'ogc', 'losc', 'rc', 'sv', 'tsg', 'if', 'ff', 'cp', 'sl']);
export const normalize = (name) => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\u00f8/g, 'o').replace(/\u00e6/g, 'ae').replace(/\u00df/g, 'ss')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter((w) => w && !STOP.has(w)).join(' ');

const TABLES = { americanfootball_nfl: NFL, americanfootball_ncaaf: NCAAF, baseball_mlb: MLB, soccer_usa_mls: MLS };
const index = (obj) => new Map(Object.entries(obj).map(([k, v]) => [normalize(k), v]));
const INDEXED = Object.fromEntries(Object.entries(TABLES).map(([s, t]) => [s, index(t)]));
const EUROPE_INDEX = index(EUROPE);

// Try the full name, then drop words from the end ("Ohio State Buckeyes" -> "Ohio State").
// The longest match wins, so "Texas State Bobcats" finds Texas State, not Texas.
function lookup(table, name, anywhere = false) {
  const words = normalize(name).split(' ');
  for (let n = words.length; n > 0; n--) {
    const hit = table.get(words.slice(0, n).join(' '));
    if (hit) return hit;
  }
  // Soccer club names put the city in different places ("Real Betis Balompie", "1. FC Union Berlin"),
  // so also try any run of words, longest first.
  if (anywhere) {
    for (let n = words.length - 1; n > 0; n--) {
      for (let i = 1; i + n <= words.length; i++) {
        const hit = table.get(words.slice(i, i + n).join(' '));
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Returns [lat, lon, roof] for the home team, or null if it isn't in our tables.
export function venueFor(sport, homeTeam) {
  if (sport.startsWith('soccer_') && sport !== 'soccer_usa_mls') return lookup(EUROPE_INDEX, homeTeam, true);
  return INDEXED[sport] ? lookup(INDEXED[sport], homeTeam, sport === 'soccer_usa_mls') : null;
}

// Search phrases for the geocoding fallback, longest first ("Montana State Bobcats" -> "Montana State Bobcats", "Montana State", "Montana").
export function placeGuesses(homeTeam) {
  const words = normalize(homeTeam).split(' ');
  const out = [];
  for (let n = words.length; n > 0; n--) out.push(words.slice(0, n).join(' '));
  // Club names often contain the city as a later word ("Real Betis Sevilla", "Red Bull Salzburg")
  for (const w of words) if (w.length >= 4 && !out.includes(w)) out.push(w);
  return out;
}
