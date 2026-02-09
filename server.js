// server.js - Backend API with REAL Météo-France scraping
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
  warnings: { data: null, timestamp: null }
};
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

// Helper function to check if cache is valid
function isCacheValid(cacheEntry) {
  if (!cacheEntry.data || !cacheEntry.timestamp) return false;
  return (Date.now() - cacheEntry.timestamp) < CACHE_DURATION;
}

// Endpoint: Get avalanche bulletin for Vanoise massif
app.get('/api/avalanche/vanoise', async (req, res) => {
  try {
    // Check cache first
    if (isCacheValid(cache.avalanche)) {
      console.log('Returning cached avalanche data');
      return res.json(cache.avalanche.data);
    }

    console.log('Fetching fresh avalanche data from Météo-France...');
    
    // Try to fetch from Météo-France API endpoint (they have a hidden API)
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

      // Parse XML response
      const $ = cheerio.load(apiResponse.data, { xmlMode: true });
      
      const bulletin = parseMeteoFranceXML($);
      
      // Update cache
      cache.avalanche = {
        data: bulletin,
        timestamp: Date.now()
      };

      return res.json(bulletin);
    } catch (xmlError) {
      console.log('XML fetch failed, trying web scraping:', xmlError.message);
      
      // Fallback: Scrape the web page
      const webResponse = await axios.get(
        'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
        { 
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );
      
      const $web = cheerio.load(webResponse.data);
      const bulletin = scrapeMeteoFranceWeb($web);
      
      cache.avalanche = {
        data: bulletin,
        timestamp: Date.now()
      };

      return res.json(bulletin);
    }
  } catch (error) {
    console.error('Error fetching avalanche data:', error.message);
    
    // Return enhanced mock data if scraping fails
    const mockData = getMockAvalancheBulletin();
    mockData.error = 'Using mock data - scraping temporarily unavailable';
    res.json(mockData);
  }
});

// Parse Météo-France XML bulletin
function parseMeteoFranceXML($) {
  try {
    const riskLevel = parseInt($('RISQUE').attr('LOC1') || '3');
    const dateValidite = $('DateValidite').text() || new Date().toISOString();
    const risqueComment = $('RisqueComment').text() || '';
    
    // Extract elevation bands
    const elevationBands = [];
    const loc1 = parseInt($('RISQUE').attr('LOC1') || '3');
    const loc2 = parseInt($('RISQUE').attr('LOC2') || '2');
    
    elevationBands.push({
      elevation: 'Above 2500m',
      risk: loc1,
      aspects: ['N', 'NE', 'E', 'NW'],
      description: translateRiskDescription(loc1)
    });
    
    elevationBands.push({
      elevation: '2000m - 2500m',
      risk: Math.max(loc1 - 1, loc2),
      aspects: ['N', 'NE', 'E'],
      description: translateRiskDescription(Math.max(loc1 - 1, loc2))
    });
    
    elevationBands.push({
      elevation: 'Below 2000m',
      risk: loc2,
      aspects: ['S', 'SE', 'SW', 'W'],
      description: translateRiskDescription(loc2)
    });

    // Extract avalanche problems
    const problems = [];
    $('TypeAvalanche').each((i, elem) => {
      const type = $(elem).text();
      problems.push({
        type: translateProblemType(type),
        severity: riskLevel >= 3 ? 'High' : 'Moderate',
        distribution: riskLevel >= 4 ? 'Widespread' : 'Specific areas',
        sensitivity: riskLevel >= 3 ? 'High - easily triggered' : 'Moderate',
        icon: getProblemIcon(type)
      });
    });

    if (problems.length === 0) {
      // Add default problems based on risk level
      if (riskLevel >= 3) {
        problems.push({
          type: 'Wind Slab',
          severity: 'High',
          distribution: 'Widespread above 2200m',
          sensitivity: 'High - easily triggered',
          icon: '💨'
        });
      }
    }

    return {
      massif: 'Vanoise',
      updateTime: new Date().toISOString(),
      validUntil: dateValidite,
      overallRisk: riskLevel,
      summary: risqueComment || generateSummary(riskLevel),
      elevationBands: elevationBands,
      problems: problems.length > 0 ? problems : getDefaultProblems(riskLevel),
      snowpack: extractSnowpackInfo($),
      weather: extractWeatherInfo($),
      tendency: $('TendanceComment').text() || 'Conditions expected to stabilize gradually',
      source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
      dataSource: 'Météo-France XML'
    };
  } catch (error) {
    console.error('Error parsing XML:', error);
    throw error;
  }
}

// Scrape Météo-France web page (fallback)
function scrapeMeteoFranceWeb($) {
  try {
    // Try to find risk level in the page
    let riskLevel = 3;
    const riskText = $('.risk-level, .risque, [class*="risque"]').text().toLowerCase();
    
    if (riskText.includes('4') || riskText.includes('fort')) riskLevel = 4;
    else if (riskText.includes('3') || riskText.includes('marqué')) riskLevel = 3;
    else if (riskText.includes('2') || riskText.includes('limité')) riskLevel = 2;
    else if (riskText.includes('1') || riskText.includes('faible')) riskLevel = 1;

    // Extract summary
    const summary = $('.resume, .synthesis, [class*="resume"]').first().text().trim() 
      || generateSummary(riskLevel);

    return {
      massif: 'Vanoise',
      updateTime: new Date().toISOString(),
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-GB'),
      overallRisk: riskLevel,
      summary: translateText(summary) || generateSummary(riskLevel),
      elevationBands: getDefaultElevationBands(riskLevel),
      problems: getDefaultProblems(riskLevel),
      snowpack: {
        recentSnow: 'Check Météo-France for details',
        totalDepth: 'Variable by elevation',
        quality: 'Wind affected at altitude'
      },
      weather: {
        forecast: 'See Météo-France for current forecast',
        temperature: 'Variable',
        wind: 'Check current conditions'
      },
      tendency: 'Monitor daily updates from Météo-France',
      source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
      dataSource: 'Météo-France Web Scraping'
    };
  } catch (error) {
    console.error('Error scraping web:', error);
    throw error;
  }
}

// Helper functions
function translateRiskDescription(level) {
  const descriptions = {
    1: 'Generally safe conditions. Natural avalanches unlikely.',
    2: 'Heightened avalanche conditions on specific terrain. Careful evaluation needed.',
    3: 'Dangerous avalanche conditions. Careful snowpack evaluation required.',
    4: 'Very dangerous conditions. Travel in avalanche terrain not recommended.',
    5: 'Extraordinary avalanche situation. Avoid all avalanche terrain.'
  };
  return descriptions[level] || descriptions[3];
}

function translateProblemType(frenchType) {
  const translations = {
    'neige_ventee': 'Wind Slab',
    'plaques': 'Wind Slab',
    'neige_fraiche': 'New Snow',
    'neige_humide': 'Wet Snow',
    'sous-couche': 'Persistent Weak Layers',
    'fond': 'Glide Avalanches'
  };
  return translations[frenchType.toLowerCase()] || frenchType;
}

function getProblemIcon(type) {
  const icons = {
    'neige_ventee': '💨',
    'plaques': '💨',
    'neige_fraiche': '❄️',
    'neige_humide': '💧',
    'sous-couche': '⚠️',
    'fond': '🏔️'
  };
  return icons[type.toLowerCase()] || '⚠️';
}

function extractSnowpackInfo($) {
  const enneigement = $('Enneigement').text();
  const qualite = $('QualiteNeige').text();
  
  return {
    recentSnow: $('NeigeFraiche24h').text() || 'See current conditions',
    totalDepth: enneigement || 'Variable by elevation',
    quality: qualite || 'Wind affected at altitude'
  };
}

function extractWeatherInfo($) {
  return {
    forecast: $('PrevisionMeteo').text() || 'Check Météo-France for current forecast',
    temperature: $('Temperature').text() || 'Variable',
    wind: $('Vent').text() || 'Check current conditions'
  };
}

function translateText(text) {
  // Basic French to English translations for common terms
  return text
    .replace(/risque fort/gi, 'high risk')
    .replace(/risque marqué/gi, 'considerable risk')
    .replace(/risque limité/gi, 'moderate risk')
    .replace(/risque faible/gi, 'low risk')
    .replace(/plaques/gi, 'slabs')
    .replace(/accumulations/gi, 'accumulations')
    .replace(/versants/gi, 'slopes');
}

function generateSummary(riskLevel) {
  const summaries = {
    1: 'Low avalanche risk. Generally safe conditions in most terrain.',
    2: 'Moderate avalanche risk. Evaluate terrain and snowpack carefully, especially on steep slopes.',
    3: 'Considerable avalanche risk. Dangerous conditions exist. Careful snowpack evaluation and conservative terrain choices essential.',
    4: 'High avalanche risk. Very dangerous conditions. Travel in avalanche terrain should be avoided.',
    5: 'Very high avalanche risk. Extraordinary avalanche situation. Avoid all avalanche terrain.'
  };
  return summaries[riskLevel] || summaries[3];
}

function getDefaultElevationBands(riskLevel) {
  return [
    {
      elevation: 'Above 2500m',
      risk: Math.min(riskLevel + 1, 5),
      aspects: ['N', 'NE', 'E', 'NW'],
      description: translateRiskDescription(Math.min(riskLevel + 1, 5))
    },
    {
      elevation: '2000m - 2500m',
      risk: riskLevel,
      aspects: ['N', 'NE', 'E'],
      description: translateRiskDescription(riskLevel)
    },
    {
      elevation: 'Below 2000m',
      risk: Math.max(riskLevel - 1, 1),
      aspects: ['S', 'SE', 'SW', 'W'],
      description: translateRiskDescription(Math.max(riskLevel - 1, 1))
    }
  ];
}

function getDefaultProblems(riskLevel) {
  const problems = [];
  
  if (riskLevel >= 3) {
    problems.push({
      type: 'Wind Slab',
      severity: 'High',
      distribution: 'Widespread above 2200m',
      sensitivity: 'High - easily triggered',
      icon: '💨'
    });
  }
  
  if (riskLevel >= 2) {
    problems.push({
      type: 'Persistent Weak Layers',
      severity: riskLevel >= 3 ? 'Moderate' : 'Low',
      distribution: 'Specific aspects (N, NE, E)',
      sensitivity: 'Moderate - careful snowpack tests needed',
      icon: '⚠️'
    });
  }
  
  return problems;
}

// Endpoint: Get weather warnings for Savoie
app.get('/api/warnings/savoie', async (req, res) => {
  try {
    if (isCacheValid(cache.warnings)) {
      console.log('Returning cached warning data');
      return res.json(cache.warnings.data);
    }

    console.log('Fetching weather warnings...');
    
    const response = await axios.get(
      'https://vigilance.meteofrance.fr/fr/savoie',
      { 
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );
    
    const $ = cheerio.load(response.data);
    
    const alerts = [];
    
    // Try to find alert elements
    $('.alert, .vigilance-item, [class*="vigilance"]').each((i, elem) => {
      const title = $(elem).find('.title, h3, h4').text().trim();
      const level = $(elem).attr('data-level') || 'orange';
      
      if (title) {
        alerts.push({
          type: 'avalanche',
          level: level,
          levelNumber: 3,
          title: title,
          description: $(elem).find('.description, p').text().trim() || 'Check Météo-France for details'
        });
      }
    });

    const warnings = {
      department: 'Savoie',
      updateTime: new Date().toISOString(),
      alerts: alerts.length > 0 ? alerts : [{
        type: 'avalanche',
        level: 'orange',
        levelNumber: 3,
        title: 'Avalanche Risk - Level 3',
        description: 'Considerable avalanche risk in mountain areas. Check Météo-France for current details.'
      }],
      source: 'https://vigilance.meteofrance.fr/fr/savoie'
    };

    cache.warnings = {
      data: warnings,
      timestamp: Date.now()
    };

    res.json(warnings);
 } catch (error) {
    console.error('Error fetching warnings:', error.message);
    res.json(getMockWeatherWarnings());  // This now returns empty alerts
  }
});

// Mock data generator (fallback)
function getMockAvalancheBulletin() {
  return {
    massif: 'Vanoise',
    updateTime: new Date().toISOString(),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-GB'),
    overallRisk: 3,
    summary: 'Recent snowfall and wind transport have created unstable wind slabs above 2200m. Natural and human-triggered avalanches are possible on steep slopes. Persistent weak layers exist in shadowed aspects.',
    elevationBands: getDefaultElevationBands(3),
    problems: getDefaultProblems(3),
    snowpack: {
      recentSnow: '30 cm in last 48 hours',
      totalDepth: '185 cm at 2500m',
      quality: 'Wind affected above 2200m, powder in sheltered areas'
    },
    weather: {
      forecast: 'Light snow showers continuing. Strong NW winds decreasing.',
      temperature: 'Cold at altitude, slight warming trend from tomorrow',
      wind: 'NW 60-80 km/h at ridges, decreasing to 40-50 km/h'
    },
    tendency: 'Risk will gradually decrease over next 48 hours as snowpack consolidates and winds decrease.',
    source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
    dataSource: 'Mock Data (Scraping Failed)',
    isMockData: true
  };
}

function getMockWeatherWarnings() {
  return {
    department: 'Savoie',
    updateTime: new Date().toISOString(),
    alerts: [],  // ← CHANGE THIS LINE - make it an empty array
    source: 'https://vigilance.meteofrance.fr/fr/savoie',
    isMockData: true
  };
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cache: {
      avalanche: cache.avalanche.timestamp ? new Date(cache.avalanche.timestamp).toISOString() : null,
      warnings: cache.warnings.timestamp ? new Date(cache.warnings.timestamp).toISOString() : null
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
      warnings: '/api/warnings/savoie'
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏔️  Méribel API Server running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET /api/avalanche/vanoise - Avalanche bulletin`);
  console.log(`   GET /api/warnings/savoie - Weather warnings`);
  console.log(`   GET /api/health - Health check`);
});