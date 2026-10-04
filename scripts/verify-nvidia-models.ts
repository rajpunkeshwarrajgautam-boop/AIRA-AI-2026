import fetch from 'node-fetch';

async function verifyNvidiaModels() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.error('NVIDIA_API_KEY is not set in the environment.');
    process.exit(1);
  }

  console.log('Querying NVIDIA NIM API for available models...');
  const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    console.error(`Failed to fetch models: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const data = await res.json();
  const models = data.data.map((m: any) => m.id);

  console.log('Available models:');
  models.forEach((m: string) => console.log(`- ${m}`));

  const targetModels = [
    'meta/llama-3.1-405b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct'
  ];

  let missing = false;
  for (const target of targetModels) {
    if (!models.includes(target)) {
      console.error(`âŒ Model ${target} is NOT available!`);
      missing = true;
    } else {
      console.log(`âœ… Model ${target} is available.`);
    }
  }

  if (missing) {
    console.error('WARNING: One or more target models are not available. Do not hardcode them!');
    process.exit(1);
  } else {
    console.log('SUCCESS: All target models are available for hosted inference.');
    process.exit(0);
  }
}

verifyNvidiaModels();
