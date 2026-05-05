# X-Agent

Local xAI realtime voice-agent console for the Inspra AI outbound agent prompt.

## Run

1. Add your xAI API key to `.env`.
2. Install dependencies:

```powershell
py -m pip install -r requirements.txt
```

3. Start the app:

```powershell
py -m uvicorn app:app --host 127.0.0.1 --port 8010 --reload
```

4. Open `http://127.0.0.1:8010`.
