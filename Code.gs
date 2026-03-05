const CLAUDE_API_KEY = 'sk-ant-YOUR_KEY_HERE'; // Paste your Claude API key here

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Wagner Wine Cellar')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getSheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');

  if (!id) {
    const ss = SpreadsheetApp.create('Wagner Wine Cellar');
    id = ss.getId();
    props.setProperty('SPREADSHEET_ID', id);
    const sheet = ss.getActiveSheet();
    sheet.setName('Bottles');
    sheet.appendRow(['id','producer','wine','vintage','varietal','region','color','notes','qty','added_at','tier']);
    return sheet;
  }

  const sheet = SpreadsheetApp.openById(id).getSheetByName('Bottles');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('tier'))  sheet.getRange(1, headers.length + 1).setValue('tier');
  const h2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!h2.includes('body'))  sheet.getRange(1, h2.length + 1).setValue('body');
  const h3 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!h3.includes('fruit')) sheet.getRange(1, h3.length + 1).setValue('fruit');
  const h4 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!h4.includes('abv'))           sheet.getRange(1, h4.length + 1).setValue('abv');
  const h5 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!h5.includes('abv_estimated')) sheet.getRange(1, h5.length + 1).setValue('abv_estimated');
  return sheet;
}

// ── Image folder ──────────────────────────────────────────────────────────────

function getImageFolder() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty('IMAGE_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch(e) {}
  }
  const folder = DriveApp.createFolder('Wagner Wine Cellar Images');
  props.setProperty('IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

function saveImage(bottleId, base64Data) {
  try {
    const folder = getImageFolder();
    // Delete any existing image for this bottle
    const existing = folder.getFilesByName(bottleId + '.jpg');
    while (existing.hasNext()) existing.next().setTrashed(true);
    // Save new image
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', bottleId + '.jpg');
    folder.createFile(blob);
  } catch(e) {
    Logger.log('saveImage error: ' + e);
  }
}

// Returns base64 string of the image, or empty string if none
function getImage(bottleId) {
  try {
    const folder = getImageFolder();
    const files = folder.getFilesByName(bottleId + '.jpg');
    if (files.hasNext()) {
      const file = files.next();
      const bytes = file.getBlob().getBytes();
      return Utilities.base64Encode(bytes);
    }
  } catch(e) {
    Logger.log('getImage error: ' + e);
  }
  return '';
}

function hasImage(bottleId) {
  try {
    const folder = getImageFolder();
    const files = folder.getFilesByName(bottleId + '.jpg');
    return files.hasNext();
  } catch(e) {}
  return false;
}

// ── Bottles ───────────────────────────────────────────────────────────────────

function getBottles() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];

  // Build image index once
  let imageIds = new Set();
  try {
    const folder = getImageFolder();
    const files = folder.getFiles();
    while (files.hasNext()) {
      const name = files.next().getName();
      if (name.endsWith('.jpg')) imageIds.add(name.replace('.jpg', ''));
    }
  } catch(e) {}

  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    if (!obj['tier']) obj['tier'] = 'everyday';
    obj['has_image'] = imageIds.has(String(obj['id']));
    return obj;
  });
}

function identifyWine(base64Front, base64Back) {
  const images = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Front } }
  ];
  if (base64Back) {
    images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Back } });
    images.push({ type: 'text', text: 'The first image is the front label, the second is the back label. Use both to identify the bottle.' });
  }
  images.push({ type: 'text', text: 'You are a wine and cider expert. Identify this bottle and respond ONLY with a JSON object, no markdown, no backticks:\n{"producer":"producer or cidery name","wine":"wine or cider name","vintage":"year or null","varietal":"grape or apple variety or null","region":"region or null","color":"Red or White or Rosé or Sparkling or Dessert or Orange or Cider","notes":"1-2 sentence tasting note","confidence":"high or medium or low","body":50,"fruit":50,"abv":"14.5% or null if unknown","abv_estimated":true}\n\nFor body: 0=very light (Pinot Grigio, Champagne), 100=very full (Amarone, Napa Cab). For fruit: 0=very earthy/savory (Barolo, Chablis, Burgundy), 100=very fruity/fruit-forward (Aussie Shiraz, Zinfandel, NZ Sauvignon Blanc). Read ABV directly from the label if visible and set abv_estimated to false. If not visible, estimate from style and region and set abv_estimated to true. Be as accurate as possible.' });

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: images
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    payload: JSON.stringify(payload)
  });

  const result = JSON.parse(response.getContentText());
  const text = result.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

function addBottle(wine, tier, imageBase64) {
  // wine object may include body and fruit scores
  Logger.log('addBottle called. imageBase64 present: ' + (imageBase64 ? 'YES, length=' + imageBase64.length : 'NO'));
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = sheet.getDataRange().getValues();
  const tierCol = headers.indexOf('tier') + 1;
  const qtyCol = headers.indexOf('qty') + 1;
  const safeTier = tier || 'everyday';

  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === wine.producer && data[i][2] === wine.wine && String(data[i][3]) === String(wine.vintage || '')) {
      sheet.getRange(i + 1, qtyCol).setValue(Number(data[i][qtyCol - 1]) + 1);
      if (tierCol > 0) sheet.getRange(i + 1, tierCol).setValue(safeTier);
      if (imageBase64) {
        Logger.log('Saving image for existing bottle id: ' + data[i][0]);
        saveImage(String(data[i][0]), imageBase64);
      }
      return 'incremented';
    }
  }

  const newId = Utilities.getUuid();
  const headers3 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = [
    newId,
    wine.producer, wine.wine, wine.vintage || '',
    wine.varietal || '', wine.region || '',
    wine.color, wine.notes || '',
    1, new Date().toISOString(), safeTier
  ];
  // Pad row to match headers, then set body/fruit
  while (row.length < headers3.length) row.push('');
  const bodyIdx = headers3.indexOf('body');
  const fruitIdx = headers3.indexOf('fruit');
  if (bodyIdx >= 0)  row[bodyIdx]  = (wine.body  !== undefined && wine.body  !== null) ? Number(wine.body)  : '';
  if (fruitIdx >= 0) row[fruitIdx] = (wine.fruit !== undefined && wine.fruit !== null) ? Number(wine.fruit) : '';
  const abvIdx = headers3.indexOf('abv');
  if (abvIdx >= 0) row[abvIdx] = wine.abv || '';
  const h5 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!h5.includes('abv_estimated')) sheet.getRange(1, h5.length + 1).setValue('abv_estimated');
  const headers4 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  while (row.length < headers4.length) row.push('');
  const abvEstIdx = headers4.indexOf('abv_estimated');
  if (abvEstIdx >= 0) row[abvEstIdx] = wine.abv_estimated ? true : false;
  sheet.appendRow(row);
  if (imageBase64) {
    Logger.log('Saving image for new bottle id: ' + newId);
    saveImage(newId, imageBase64);
  }
  Logger.log('addBottle complete: ' + (imageBase64 ? 'image saved' : 'no image'));
  return 'added';
}

// Test the full add-with-image flow
function testAddWithImage() {
  const tinyJpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
  const fakeWine = { producer: 'Test Winery', wine: 'Debug Red', vintage: '2020', varietal: 'Cabernet', region: 'Test', color: 'Red', notes: 'Test bottle' };
  Logger.log('--- Testing full add+image flow ---');
  const result = addBottle(fakeWine, 'everyday', tinyJpeg);
  Logger.log('addBottle result: ' + result);
  const bottles = getBottles();
  const found = bottles.find(b => b.producer === 'Test Winery');
  Logger.log('has_image on retrieved bottle: ' + (found ? found.has_image : 'bottle not found'));
}

function removeBottle(wine) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === wine.producer && data[i][2] === wine.wine && String(data[i][3]) === String(wine.vintage || '')) {
      const qty = Number(data[i][8]);
      if (qty <= 1) { sheet.deleteRow(i + 1); }
      else { sheet.getRange(i + 1, 9).setValue(qty - 1); }
      return 'removed';
    }
  }
  return 'not_found';
}

function adjustQty(id, delta) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const qtyCol = headers.indexOf('qty') + 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      const newQty = Number(data[i][qtyCol - 1]) + delta;
      if (newQty <= 0) { sheet.deleteRow(i + 1); }
      else { sheet.getRange(i + 1, qtyCol).setValue(newQty); }
      return 'ok';
    }
  }
  return 'not_found';
}

function updateTier(id, tier) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const tierCol = headers.indexOf('tier') + 1;
  if (tierCol === 0) return 'no_tier_column';
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      sheet.getRange(i + 1, tierCol).setValue(tier);
      return 'ok';
    }
  }
  return 'not_found';
}

function pickWine(color, mood, food, occasion, company, adventure) {
  const bottles = getBottles();
  if (!bottles.length) return { error: 'Your cellar is empty.' };

  const inventory = bottles.map(b =>
    `- id:${b.id} | ${b.producer} ${b.wine}${b.vintage ? ' ' + b.vintage : ''} | ${b.color} | ${b.varietal || 'unknown varietal'} | ${b.region || 'unknown region'} | Tier: ${b.tier || 'everyday'} | Notes: ${b.notes || 'none'} | Qty: ${b.qty}`
  ).join('\n');

  const prompt = `You are a sommelier. A person wants a wine recommendation from their personal cellar.

Their answers:
- Wine color preference: ${color}
- Mood / style: ${mood}
- Food pairing: ${food}
- Occasion: ${occasion}
- Who they are drinking with: ${company}
- Adventurousness: ${adventure}

Their cellar inventory:
${inventory}

Recommend 2-3 wines from this exact list that best match all six of their answers. If they selected a specific color (not 'No preference'), only recommend wines of that color. Consider the adventurousness answer carefully — if they want something reliable, pick the most obvious match; if they want to be surprised, find something unexpected that still works. Respond ONLY with a JSON array, no markdown, no backticks:
[
  {
    "id": "exact id value from inventory",
    "producer": "exact producer name from inventory",
    "wine": "exact wine name from inventory",
    "vintage": "exact vintage from inventory or null",
    "tier": "everyday or weekend or special",
    "reason": "2-3 sentences explaining why this wine fits their mood, food, occasion, company, and spirit of adventure"
  }
]`;

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    payload: JSON.stringify(payload)
  });

  const result = JSON.parse(response.getContentText());
  const text = result.content[0].text.replace(/```json|```/g, '').trim();
  const picks = JSON.parse(text);

  // Attach image data server-side — no client-side matching needed
  const bottleMap = {};
  bottles.forEach(b => { bottleMap[b.id] = b; });

  picks.forEach(p => {
    let bottle = bottleMap[p.id];
    if (!bottle) {
      // Fallback: match by producer + wine
      bottle = bottles.find(b => b.producer === p.producer && b.wine === p.wine);
    }
    p.bottle_id   = bottle ? bottle.id : '';
    p.image_data  = (bottle && bottle.has_image) ? getImage(bottle.id) : '';
  });

  return picks;
}

// ── Debug functions — run individually in the Apps Script editor ──

function testDriveAccess() {
  try {
    Logger.log('Step 1: Testing DriveApp.getRootFolder...');
    const root = DriveApp.getRootFolder();
    Logger.log('Root folder name: ' + root.getName());
    
    Logger.log('Step 2: Creating test folder in root...');
    const folder = root.createFolder('WagnerWineCellarTest_DELETE_ME');
    Logger.log('Folder created: ' + folder.getName() + ' id: ' + folder.getId());
    
    Logger.log('Step 3: Creating test file...');
    const tinyJpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
    const blob = Utilities.newBlob(Utilities.base64Decode(tinyJpeg), 'image/jpeg', 'test.jpg');
    const file = folder.createFile(blob);
    Logger.log('File created: ' + file.getName());
    
    Logger.log('Step 4: Reading file back...');
    const bytes = file.getBlob().getBytes();
    const encoded = Utilities.base64Encode(bytes);
    Logger.log('Read back length: ' + encoded.length);
    
    Logger.log('Step 5: Cleaning up...');
    file.setTrashed(true);
    folder.setTrashed(true);
    Logger.log('SUCCESS — Drive read/write is fully working.');
  } catch(e) {
    Logger.log('FAILED at step above: ' + e.toString());
  }
}

function testImageRoundtrip() {
  const tinyJpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
  const testId = 'test-bottle-123';
  Logger.log('Saving test image...');
  saveImage(testId, tinyJpeg);
  Logger.log('Retrieving test image...');
  const result = getImage(testId);
  if (result && result.length > 0) {
    Logger.log('SUCCESS: image round-trip works. Length: ' + result.length);
  } else {
    Logger.log('FAIL: getImage returned empty.');
  }
}
