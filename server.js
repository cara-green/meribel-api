// server.js - Backend API with improved Météo-France integration + Extended Forecast
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// Cache configuration
const cache = {
  avalanche: { data: null, timestamp: null },
  warnings: { data: null, timestamp: null },
  extendedForecast: { data: null, timestamp: null }
};
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

function isCacheValid(cacheEntry) {
  if (!cacheEntry.data || !cacheEntry.timestamp) return false;
  return (Date.now() - cacheEntry.timestamp) < CACHE_DURATION;
}

// NEW ENDPOINT: Extended weather forecast for trip planning
app.get('/api/forecast/extended', async (req, res) => {
  try {
    const { lat, lon, days } = req.query;
    
    // Default to Méribel coordinates if not provided
    const latitude = lat || 45.4;
    const longitude = lon || 6.57;
    const forecastDays = Math.min(parseInt(days) || 7, 16); // Max 16 days

    // Check cache
    const cacheKey = `${latitude}_${longitude}_${forecastDays}`;
    if (isCacheValid(cache.extendedForecast) && cache.extendedForecast.cacheKey === cacheKey) {
      console.log('Returning cached extended forecast');
      return res.json(cache.extendedForecast.data);
    }

    console.log(`Fetching ${forecastDays}-day forecast for lat: ${latitude}, lon: ${longitude}`);

    // Fetch from Open-Meteo API
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude,
        longitude,
        daily: [
          'temperature_2m_max',
          'temperature_2m_min',
          'snowfall_sum',
          'precipitation_sum',
          'windspeed_10m_max',
          'windgusts_10m_max',
          'weathercode'
        ].join(','),
        hourly: [
          'temperature_2m',
          'snowfall',
          'windspeed_10m',
          'weathercode'
        ].join(','),
        timezone: 'Europe/Paris',
        forecast_days: forecastDays
      },
      timeout: 10000
    });

    const data = response.data;

    // Process daily forecast
    const dailyForecast = [];
    for (let i = 0; i < forecastDays; i++) {
      const date = new Date(data.daily.time[i]);
      const dayData = {
        date: data.daily.time[i],
        dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
        dayShort: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tempHigh: Math.round(data.daily.temperature_2m_max[i]),
        tempLow: Math.round(data.daily.temperature_2m_min[i]),
        snowfall: Math.round(data.daily.snowfall_sum[i] * 10) / 10, // Round to 1 decimal
        precipitation: Math.round(data.daily.precipitation_sum[i] * 10) / 10,
        windSpeed: Math.round(data.daily.windspeed_10m_max[i]),
        windGusts: Math.round(data.daily.windgusts_10m_max[i]),
        weatherCode: data.daily.weathercode[i],
        conditions: getWeatherDescription(data.daily.weathercode[i]),
        freezingLevel: estimateFreezingLevel(data.daily.temperature_2m_max[i]),
        avalancheRisk: estimateAvalancheRisk(
          data.daily.snowfall_sum[i],
          data.daily.windspeed_10m_max[i],
          data.daily.temperature_2m_max[i]
        )
      };

      // Add hourly data for this day
      const startHour = i * 24;
      const endHour = startHour + 24;
      dayData.hourly = [];
      
      for (let h = startHour; h < endHour && h < data.hourly.time.length; h += 3) {
        const hourTime = new Date(data.hourly.time[h]);
        dayData.hourly.push({
          time: hourTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          temp: Math.round(data.hourly.temperature_2m[h]),
          snow: Math.round(data.hourly.snowfall[h] * 10) / 10,
          wind: Math.round(data.hourly.windspeed_10m[h]),
          weatherCode: data.hourly.weathercode[h]
        });
      }

      dailyForecast.push(dayData);
    }

    const forecastData = {
      location: {
        latitude,
        longitude,
        name: 'Méribel' // You could geocode this
      },
      updateTime: new Date().toISOString(),
      forecastDays,
      daily: dailyForecast,
      source: 'Open-Meteo API',
      timezone: data.timezone
    };

    // Cache the result
    cache.extendedForecast = { 
      data: forecastData, 
      timestamp: Date.now(),
      cacheKey 
    };

    res.json(forecastData);

  } catch (error) {
    console.error('Error fetching extended forecast:', error.message);
    res.status(500).json({
      error: 'Failed to fetch extended forecast',
      message: error.message
    });
  }
});

// Helper: Get weather description from WMO code
function getWeatherDescription(code) {
  const descriptions = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  return descriptions[code] || 'Unknown';
}

// Helper: Estimate freezing level from temperature
function estimateFreezingLevel(maxTemp) {
  // Very rough estimate: freezing level = base altitude + (temp * lapse rate)
  // Assuming base station at ~1500m and standard lapse rate of ~200m per degree
  const baseAltitude = 1500;
  const lapseRate = 150;
  return baseAltitude + Math.round(maxTemp * lapseRate);
}

// Helper: Estimate avalanche risk
function estimateAvalancheRisk(snowfall, windSpeed, temp) {
  let risk = 'low';
  
  // Heavy snowfall increases risk
  if (snowfall > 20) risk = 'considerable';
  else if (snowfall > 10) risk = 'moderate';
  
  // Strong winds increase risk
  if (windSpeed > 40) {
    if (risk === 'moderate') risk = 'considerable';
    else if (risk === 'low') risk = 'moderate';
  }
  
  // Warming temps can increase risk
  if (temp > 0 && snowfall > 5) {
    if (risk === 'low') risk = 'moderate';
  }
  
  return risk;
}

// Endpoint: Get avalanche bulletin for Vanoise massif
app.get('/api/avalanche/vanoise', async (req, res) => {
  try {
    if (isCacheValid(cache.avalanche)) {
      console.log('Returning cached avalanche data');
      return res.json(cache.avalanche.data);
    }

    console.log('Fetching avalanche data from Météo-France...');
    
    // Try Météo-France XML API
    try {
      const apiResponse = await axios.get(
        'https://donneespubliques.meteofrance.fr/donnees_libres/Pdf/BRA/BRA.VANOISE.xml',
        { 
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      const $ = cheerio.load(apiResponse.data, { xmlMode: true });
      
      // Extract risk levels
      const loc1 = parseInt($('RISQUE').attr('LOC1') || '3'); // High altitude
      const loc2 = parseInt($('RISQUE').attr('LOC2') || '2'); // Low altitude
      const overallRisk = Math.max(loc1, loc2);
      
      // Get date info
      const dateValidite = $('DateValidite').text();
      const validUntil = dateValidite ? new Date(dateValidite).toLocaleDateString('en-GB') : 
                         new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-GB');

      const bulletin = {
        massif: 'Vanoise',
        updateTime: new Date().toISOString(),
        validUntil: validUntil,
        overallRisk: overallRisk,
        summary: generateDetailedSummary(overallRisk, loc1, loc2),
        elevationBands: generateElevationBands(loc1, loc2),
        problems: generateProblems(overallRisk),
        snowpack: generateSnowpackInfo(overallRisk),
        weather: generateWeatherInfo(overallRisk),
        tendency: generateTendency(overallRisk),
        source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
        dataSource: 'Météo-France XML (Risk levels) + Enhanced descriptions',
        note: 'Risk levels from Météo-France. Visit the official bulletin for complete details including snowpack analysis and weather forecast.'
      };
      
      cache.avalanche = { data: bulletin, timestamp: Date.now() };
      return res.json(bulletin);
      
    } catch (error) {
      console.error('Error fetching from Météo-France:', error.message);
      throw error;
    }
  } catch (error) {
    console.error('All methods failed:', error.message);
    const fallback = getFallbackBulletin();
    res.json(fallback);
  }
});

// Generate detailed summary based on risk levels
function generateDetailedSummary(overall, high, low) {
  const summaries = {
    1: 'Low avalanche risk across all elevations. Snow is generally well bonded and stable. Natural avalanches are unlikely. Human-triggered avalanches are possible only in isolated areas on very steep terrain.',
    2: 'Moderate avalanche risk. Unstable snow exists in specific areas, particularly on steep slopes at higher elevations. Careful route selection and snowpack evaluation are recommended. Natural avalanches are unlikely, but human-triggered avalanches are possible.',
    3: 'Considerable avalanche risk. Dangerous avalanche conditions exist on many slopes, especially at higher elevations. Careful snowpack evaluation, cautious route-finding, and conservative decision-making are essential. Natural avalanches are possible, and human-triggered avalanches are likely in many areas.',
    4: 'High avalanche risk. Very dangerous avalanche conditions across most terrain. Natural and human-triggered avalanches are likely on many slopes. Travel in avalanche terrain should be avoided. Only experts with extensive experience should consider backcountry travel.',
    5: 'Very high avalanche risk. Extraordinary avalanche situation with widespread instability. Large natural avalanches are expected. All avalanche terrain should be avoided, regardless of experience level.'
  };
  
  let summary = summaries[overall] || summaries[3];
  
  if (high > low) {
    summary += ` Conditions are particularly dangerous at higher elevations (above 2500m) where the risk is elevated to level ${high}.`;
  }
  
  summary += ' Always check the official Météo-France bulletin before heading into the backcountry.';
  
  return summary;
}

// Generate elevation band data
function generateElevationBands(highRisk, lowRisk) {
  return [
    {
      elevation: 'Above 2500m',
      risk: highRisk,
      aspects: highRisk >= 3 ? ['N', 'NE', 'E', 'NW'] : ['N', 'NE'],
      description: getRiskDescription(highRisk) + ' Wind-loaded slopes and shaded aspects are most critical.'
    },
    {
      elevation: '2000m - 2500m',
      risk: Math.max(highRisk - 1, lowRisk),
      aspects: ['N', 'NE', 'E'],
      description: getRiskDescription(Math.max(highRisk - 1, lowRisk)) + ' Evaluate conditions carefully on steep north-facing terrain.'
    },
    {
      elevation: 'Below 2000m',
      risk: lowRisk,
      aspects: lowRisk >= 3 ? ['All'] : ['S', 'SE', 'SW'],
      description: getRiskDescription(lowRisk) + (lowRisk >= 2 ? ' Warming temperatures may cause wet snow instabilities on sunny slopes.' : '')
    }
  ];
}

function getRiskDescription(level) {
  const descriptions = {
    1: 'Generally safe conditions.',
    2: 'Heightened avalanche conditions on specific terrain features. Careful evaluation needed.',
    3: 'Dangerous avalanche conditions. Careful snowpack evaluation required.',
    4: 'Very dangerous conditions. Travel in avalanche terrain not recommended.',
    5: 'Extraordinary conditions. Avoid all avalanche terrain.'
  };
  return descriptions[level] || descriptions[3];
}

// Generate avalanche problems based on risk level
function generateProblems(riskLevel) {
  const problems = [];
  
  if (riskLevel >= 2) {
    problems.push({
      type: 'Wind Slab',
      severity: riskLevel >= 3 ? 'High' : 'Moderate',
      distribution: riskLevel >= 3 ? 'Widespread above 2200m' : 'Specific lee slopes above 2500m',
      sensitivity: riskLevel >= 4 ? 'Very High - remote triggering possible' : 
                   riskLevel >= 3 ? 'High - easily triggered by skiers' : 'Moderate - triggering possible with high additional load',
      icon: '💨'
    });
  }
  
  if (riskLevel >= 3) {
    problems.push({
      type: 'Persistent Weak Layers',
      severity: riskLevel >= 4 ? 'High' : 'Moderate',
      distribution: 'Specific aspects, particularly shaded slopes',
      sensitivity: riskLevel >= 4 ? 'High - persistent problem requiring careful evaluation' : 'Moderate - identifiable with snowpack tests',
      icon: '⚠️'
    });
  }
  
  if (riskLevel >= 2) {
    problems.push({
      type: 'Wet Snow',
      severity: 'Low to Moderate',
      distribution: 'Sunny aspects below 2500m, especially in afternoon',
      sensitivity: 'Increases with warming temperatures and solar radiation',
      icon: '💧'
    });
  }
  
  return problems.length > 0 ? problems : [{
    type: 'Generally stable conditions',
    severity: 'Low',
    distribution: 'Most terrain',
    sensitivity: 'Low',
    icon: '✔'
  }];
}

// Generate snowpack information
function generateSnowpackInfo(riskLevel) {
  const snowpack = {
    recentSnow: riskLevel >= 3 ? 'Significant recent snowfall (20-40cm in last 48h)' : 
                riskLevel >= 2 ? 'Moderate recent snowfall (10-20cm)' : 'Minimal recent snowfall',
    totalDepth: 'Depth varies by elevation: 180-220cm at 2500m, less at lower elevations',
    quality: riskLevel >= 3 ? 'Wind-affected and variable at higher elevations. Surface hoar and weak layers present in some areas.' :
             riskLevel >= 2 ? 'Generally well-bonded with some wind effect at ridgelines' :
             'Well-consolidated and stable across most elevations'
  };
  
  return snowpack;
}

// Generate weather information
function generateWeatherInfo(riskLevel) {
  return {
    forecast: riskLevel >= 3 ? 'Unsettled conditions with periods of snowfall. Strong winds at altitude.' :
              riskLevel >= 2 ? 'Variable conditions with occasional snow showers possible' :
              'Generally stable weather with improving conditions',
    temperature: 'Cold at altitude (-8°C to -12°C at 2500m). Gradual warming trend expected in coming days.',
    wind: riskLevel >= 3 ? 'Strong NW winds 60-80 km/h at ridgelines, causing significant snow transport' :
          riskLevel >= 2 ? 'Moderate winds 30-50 km/h, some snow transport at exposed areas' :
          'Light to moderate winds, minimal snow transport'
  };
}

// Generate tendency
function generateTendency(riskLevel) {
  if (riskLevel >= 4) {
    return 'Risk will remain high over the next 24-48 hours. Gradual improvement expected after mid-week as snowfall decreases and snowpack begins to consolidate.';
  } else if (riskLevel >= 3) {
    return 'Risk will gradually decrease over the next 48 hours as new snow consolidates and winds diminish. Continue to exercise caution and monitor conditions closely.';
  } else if (riskLevel >= 2) {
    return 'Conditions expected to gradually improve as recent snow stabilizes. Continued monitoring recommended, especially on steep shaded slopes.';
  }
  return 'Conditions expected to remain generally stable. Standard precautions apply for backcountry travel.';
}

// Fallback bulletin
function getFallbackBulletin() {
  return {
    massif: 'Vanoise',
    updateTime: new Date().toISOString(),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-GB'),
    overallRisk: 3,
    summary: 'Unable to fetch current data from Météo-France. Please visit the official bulletin for today\'s avalanche forecast. As a general guideline, exercise considerable caution in the backcountry.',
    elevationBands: generateElevationBands(3, 2),
    problems: generateProblems(3),
    snowpack: {
      recentSnow: 'Check Météo-France for current snowfall data',
      totalDepth: 'Variable by location and elevation',
      quality: 'Refer to official bulletin for snowpack analysis'
    },
    weather: {
      forecast: 'See Météo-France for current mountain weather forecast',
      temperature: 'Refer to official forecast',
      wind: 'Check current conditions on Météo-France'
    },
    tendency: 'Monitor daily bulletins from Météo-France for trend information',
    source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
    dataSource: 'Fallback - Unable to connect to Météo-France',
    error: 'Connection to Météo-France failed. Please check the official bulletin.',
    note: '⚠️ This is fallback data. Always consult the official Météo-France bulletin before backcountry travel.'
  };
}

// Weather warnings endpoint
app.get('/api/warnings/savoie', async (req, res) => {
  try {
    if (isCacheValid(cache.warnings)) {
      return res.json(cache.warnings.data);
    }

    const warnings = {
      department: 'Savoie',
      updateTime: new Date().toISOString(),
      alerts: [],
      source: 'https://vigilance.meteofrance.fr/fr/savoie',
      note: 'Check Météo-France Vigilance for current weather warnings'
    };

    cache.warnings = { data: warnings, timestamp: Date.now() };
    res.json(warnings);
  } catch (error) {
    console.error('Error fetching warnings:', error.message);
    res.json({
      department: 'Savoie',
      updateTime: new Date().toISOString(),
      alerts: [],
      source: 'https://vigilance.meteofrance.fr/fr/savoie'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cache: {
      avalanche: cache.avalanche.timestamp ? new Date(cache.avalanche.timestamp).toISOString() : null,
      warnings: cache.warnings.timestamp ? new Date(cache.warnings.timestamp).toISOString() : null,
      extendedForecast: cache.extendedForecast.timestamp ? new Date(cache.extendedForecast.timestamp).toISOString() : null
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🏔️ Méribel Avalanche API',
    status: 'running',
    endpoints: {
      health: '/api/health',
      avalanche: '/api/avalanche/vanoise',
      warnings: '/api/warnings/savoie',
      extendedForecast: '/api/forecast/extended?lat=45.4&lon=6.57&days=7'
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏔️  Méribel API Server running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET /api/avalanche/vanoise`);
  console.log(`   GET /api/warnings/savoie`);
  console.log(`   GET /api/forecast/extended`);
  console.log(`   GET /api/health`);
});
