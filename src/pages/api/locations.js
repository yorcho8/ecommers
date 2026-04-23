const COUNTRIESNOW = 'https://countriesnow.space/api/v0.1';
const RESTCOUNTRIES = 'https://restcountries.com/v3.1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400', 
    },
  });
}

async function getAmericasCountries() {
  const res = await fetch(`${RESTCOUNTRIES}/region/americas?fields=name,cca2`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('restcountries error');
  const data = await res.json();

  const countries = data
    .map((c) => ({ name: c.name?.common ?? '', code: c.cca2 ?? '' }))
    .filter((c) => c.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return countries;
}

async function getStates(country) {
  const res = await fetch(`${COUNTRIESNOW}/countries/states`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ country }),
  });
  if (!res.ok) throw new Error('countriesnow states error');
  const data = await res.json();
  if (data.error) throw new Error(data.msg || 'states error');

  const states = (data.data?.states ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));

  return states;
}

async function getCities(country, state) {
  const res = await fetch(`${COUNTRIESNOW}/countries/state/cities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ country, state }),
  });
  if (!res.ok) throw new Error('countriesnow cities error');
  const data = await res.json();
  if (data.error) throw new Error(data.msg || 'cities error');

  const cities = (data.data ?? [])
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));

  return cities;
}

export async function GET({ url }) {
  const action = url.searchParams.get('action');

  try {
    if (action === 'countries') {
      const countries = await getAmericasCountries();
      return json({ success: true, data: countries });
    }

    if (action === 'states') {
      const country = url.searchParams.get('country');
      if (!country) return json({ success: false, error: 'Falta el parametro country' }, 400);
      const states = await getStates(country);
      return json({ success: true, data: states });
    }

    if (action === 'cities') {
      const country = url.searchParams.get('country');
      const state = url.searchParams.get('state');
      if (!country || !state) return json({ success: false, error: 'Faltan parametros country o state' }, 400);
      const cities = await getCities(country, state);
      return json({ success: true, data: cities });
    }

    return json({ success: false, error: 'action invalida. Usa: countries, states o cities' }, 400);
  } catch (err) {
    console.error('[GET /api/locations] Error:', err);
    return json({ success: false, error: 'Error obteniendo datos de ubicacion' }, 502);
  }
}
