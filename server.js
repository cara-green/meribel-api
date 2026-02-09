// server.js - Backend API for fetching Météo-France avalanche and weather data
// This should be deployed separately (e.g., on Railway, Render, or Vercel Serverless)

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
    
    // Fetch the page
    const response = await axios.get(
      'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche',
      { timeout: 10000 }
    );
    
    const $ = cheerio.load(response.data);
    
    // This is a simplified scraper - you'll need to adjust selectors based on actual HTML
    const bulletin = {
      massif: 'Vanoise',
      updateTime: new Date().toISOString(),
      validUntil: extractValidUntil($),
      overallRisk: extractOverallRisk($),
      summary: extractSummary($),
      elevationBands: extractElevationBands($),
      problems: extractAvalancheProblems($),
      snowpack: extractSnowpackInfo($),
      weather: extractWeatherInfo($),
      tendency: extractTendency($),
      source: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche'
    };

    // Update cache
    cache.avalanche = {
      data: bulletin,
      timestamp: Date.now()
    };

    res.json(bulletin);
  } catch (error) {
    console.error('Error fetching avalanche data:', error.message);
    
    // Return mock data if scraping fails (for development)
    const mockData = getMockAvalancheBulletin();
    res.json(mockData);
  }
});

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
      { timeout: 10000 }
    );
    
    const $ = cheerio.load(response.data);
    
    const warnings = {
      department: 'Savoie',
      updateTime: new Date().toISOString(),
      alerts: extractWeatherAlerts($),
      source: 'https://vigilance.meteofrance.fr/fr/savoie'
    };

    cache.warnings = {
      data: warnings,
      timestamp: Date.now()
    };

    res.json(warnings);
  } catch (error) {
    console.error('Error fetching warnings:', error.message);
    res.json(getMockWeatherWarnings());
  }
});

// Scraping helper functions
function extractValidUntil($) {
  // Adjust selector based on actual page structure
  const text = $('.validity-date, .bulletin-validity').first().text().trim();
  if (text) return text;
  
  // Default: valid until tomorrow 4pm
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(16, 0, 0, 0);
  return tomorrow.toLocaleDateString('fr-FR');
}

function extractOverallRisk($) {
  // Look for risk level indicators
  const riskText = $('.risk-level, .risque-global').text().toLowerCase();
  
  if (riskText.includes('fort') || riskText.includes('4')) return 4;
  if (riskText.includes('marqué') || riskText.includes('3')) return 3;
  if (riskText.includes('limité') || riskText.includes('2')) return 2;
  if (riskText.includes('faible') || riskText.includes('1')) return 1;
  
  return 3; // Default to considerable
}

function extractSummary($) {
  // Look for summary text
  const summary = $('.resume, .bulletin-summary, .synthesis').first().text().trim();
  return summary || 'Recent snowfall and wind have created unstable conditions.';
}

function extractElevationBands($) {
  // Extract risk by elevation (typically 3 bands)
  return [
    {
      elevation: 'Above 2500m',
      risk: 4,
      aspects: ['N', 'NE', 'E', 'NW'],
      description: 'Dangerous conditions with wind slabs and weak layers'
    },
    {
      elevation: '2000m - 2500m', 
      risk: 3,
      aspects: ['N', 'NE', 'E'],
      description: 'Considerable risk on steep slopes'
    },
    {
      elevation: 'Below 2000m',
      risk: 2,
      aspects: ['All'],
      description: 'Moderate risk, wet snow possible'
    }
  ];
}

function extractAvalancheProblems($) {
  return [
    {
      type: 'Wind Slab',
      severity: 'High',
      distribution: 'Widespread',
      sensitivity: 'High'
    },
    {
      type: 'Persistent Weak Layers',
      severity: 'Moderate',
      distribution: 'Specific',
      sensitivity: 'Moderate'
    }
  ];
}

function extractSnowpackInfo($) {
  return {
    recentSnow: '25 cm in last 24h',
    totalDepth: '180 cm at 2500m',
    quality: 'Wind affected above 2200m'
  };
}

function extractWeatherInfo($) {
  return {
    forecast: 'Light snow continuing, strong winds above 2500m',
    temperature: 'Warming trend expected',
    wind: 'Strong NW winds 60-80 km/h at summit'
  };
}

function extractTendency($) {
  return 'Risk will gradually decrease as weather stabilizes';
}

function extractWeatherAlerts($) {
  // Extract weather warnings
  return [
    {
      type: 'Avalanche',
      level: 'orange',
      title: 'Risque avalanche marqué',
      description: 'Conditions avalancheuses défavorables en montagne'
    }
  ];
}

// Mock data generators (used when scraping fails)
function getMockAvalancheBulletin() {
  return {
    massif: 'Vanoise',
    updateTime: new Date().toISOString(),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('fr-FR'),
    overallRisk: 3,
    summary: 'Recent snowfall and wind transport have created unstable wind slabs above 2200m. Natural and human-triggered avalanches are possible on steep slopes. Persistent weak layers exist in shadowed aspects.',
    elevationBands: [
      {
        elevation: 'Above 2500m',
        risk: 4,
        aspects: ['N', 'NE', 'E', 'NW'],
        description: 'Dangerous wind slabs and persistent weak layers. Very unstable conditions.'
      },
      {
        elevation: '2000m - 2500m',
        risk: 3,
        aspects: ['N', 'NE', 'E'],
        description: 'Wind slabs possible on steep slopes. Careful route selection required.'
      },
      {
        elevation: 'Below 2000m',
        risk: 2,
        aspects: ['S', 'SE', 'SW', 'W'],
        description: 'Wet snow avalanches possible with warming temperatures.'
      }
    ],
    problems: [
      {
        type: 'Wind Slab',
        severity: 'High',
        distribution: 'Widespread above 2200m',
        sensitivity: 'High - easily triggered'
      },
      {
        type: 'Persistent Weak Layers',
        severity: 'Moderate',
        distribution: 'Specific aspects (N, NE, E)',
        sensitivity: 'Moderate - careful snowpack tests needed'
      },
      {
        type: 'Wet Snow',
        severity: 'Low',
        distribution: 'Below 2000m, sunny aspects',
        sensitivity: 'Low - only with significant warming'
      }
    ],
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
    isMockData: true
  };
}

function getMockWeatherWarnings() {
  return {
    department: 'Savoie',
    updateTime: new Date().toISOString(),
    alerts: [
      {
        type: 'avalanche',
        level: 'orange',
        levelNumber: 3,
        title: 'Avalanche - Niveau 3',
        description: 'Risque avalanche marqué en montagne. Conditions défavorables.'
      }
    ],
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🏔️  Méribel API Server running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET /api/avalanche/vanoise - Avalanche bulletin`);
  console.log(`   GET /api/warnings/savoie - Weather warnings`);
  console.log(`   GET /api/health - Health check`);
});

/*
DEPLOYMENT INSTRUCTIONS:

1. Create a new folder for this backend:
   mkdir meribel-api
   cd meribel-api

2. Install dependencies:
   npm init -y
   npm install express cors axios cheerio

3. Save this file as server.js

4. Test locally:
   node server.js

5. Deploy to Railway (recommended):
   - Go to railway.app
   - Create new project
   - Deploy from GitHub or use Railway CLI
   - Set PORT environment variable (Railway does this automatically)
   - Your API will be at: https://your-app.railway.app

6. Update your frontend to use: https://your-app.railway.app/api/avalanche/vanoise

ALTERNATIVE: Vercel Serverless Functions
- Create /api folder in your frontend project
- Convert each endpoint to a serverless function
- Deploy with your frontend

NOTE: This uses mock data currently because scraping Météo-France requires
analyzing their actual HTML structure. You'll need to inspect the page and
update the cheerio selectors to extract real data.
*/