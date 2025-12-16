# 🚀 DEPLOYMENT GUIDE - AI Trading System

Complete guide to deploy your AI trading system to the cloud!

---

## 🎯 **CHOOSE YOUR PLATFORM**

| Platform | Difficulty | Free Tier | Best For |
|----------|-----------|-----------|----------|
| **Railway** | ⭐ Easy | $5 credit/month | Beginners |
| **Render** | ⭐⭐ Easy | Yes (with limits) | Free hosting |
| **Heroku** | ⭐⭐ Medium | Limited | Established apps |
| **Vercel** | ⭐ Easy | Yes | Static + API |

---

## 1️⃣ **RAILWAY (RECOMMENDED)**

### **Why Railway?**
- ✅ Easiest deployment
- ✅ $5 free credit/month
- ✅ Automatic HTTPS
- ✅ GitHub integration
- ✅ Environment variables easy

### **Step-by-Step:**

**1. Prepare Your Code:**
```bash
# Make sure you have these files:
# - server.js
# - package.json
# - public/index.html
# - .env.example (NOT .env!)

# Create Git repository
git init
git add .
git commit -m "Initial commit"
```

**2. Push to GitHub:**
```bash
# Create new repo on github.com
# Then:
git remote add origin https://github.com/YOUR_USERNAME/ai-trading-system.git
git branch -M main
git push -u origin main
```

**3. Deploy to Railway:**

1. Go to: https://railway.app
2. Click: **Sign up with GitHub**
3. Click: **New Project**
4. Choose: **Deploy from GitHub repo**
5. Select: **your ai-trading-system repo**
6. Railway auto-detects Node.js and deploys!

**4. Add Environment Variables:**

1. Go to your project
2. Click: **Variables** tab
3. Add:
   ```
   FINNHUB_API_KEY = your_finnhub_key
   NEWS_API_KEY = your_newsapi_key
   OPENAI_API_KEY = your_openai_key (optional)
   NODE_ENV = production
   ```
4. Click: **Deploy** (Railway redeploys automatically)

**5. Get Your URL:**
- Click: **Settings** → **Domains**
- Railway gives you: `your-app.up.railway.app`
- Optional: Add custom domain

**✅ DONE! Your app is live!**

---

## 2️⃣ **RENDER**

### **Why Render?**
- ✅ Generous free tier
- ✅ Easy to use
- ✅ Automatic deploys
- ⚠️ Sleeps after 15min inactivity (free tier)

### **Step-by-Step:**

**1. Push to GitHub** (same as Railway above)

**2. Deploy to Render:**

1. Go to: https://render.com
2. Sign up with GitHub
3. Click: **New** → **Web Service**
4. Connect: **your repository**
5. Configure:
   ```
   Name: ai-trading-system
   Environment: Node
   Build Command: npm install
   Start Command: npm start
   ```
6. Choose: **Free** plan
7. Click: **Create Web Service**

**3. Add Environment Variables:**

1. In your service dashboard
2. Go to: **Environment** tab
3. Add:
   ```
   FINNHUB_API_KEY
   NEWS_API_KEY
   OPENAI_API_KEY
   NODE_ENV = production
   ```
4. Save (auto-redeploys)

**4. Your URL:**
- Render gives: `your-app.onrender.com`
- First request after sleep takes ~30 seconds

**✅ DONE!**

---

## 3️⃣ **HEROKU**

### **Why Heroku?**
- ✅ Well-established
- ✅ Good documentation
- ⚠️ No more free tier (starts $5/month)

### **Step-by-Step:**

**1. Install Heroku CLI:**
```bash
# Mac
brew install heroku/brew/heroku

# Windows
# Download from: https://devcenter.heroku.com/articles/heroku-cli
```

**2. Login:**
```bash
heroku login
```

**3. Create App:**
```bash
heroku create your-app-name
```

**4. Add Environment Variables:**
```bash
heroku config:set FINNHUB_API_KEY=your_key
heroku config:set NEWS_API_KEY=your_key
heroku config:set OPENAI_API_KEY=your_key
heroku config:set NODE_ENV=production
```

**5. Deploy:**
```bash
git push heroku main
```

**6. Open App:**
```bash
heroku open
```

**✅ DONE!**

---

## 4️⃣ **VERCEL**

### **Why Vercel?**
- ✅ Great for frontend
- ✅ Serverless functions
- ⚠️ Need to adapt backend

### **Step-by-Step:**

**Note:** Vercel is better for static sites. For this full-stack app, Railway or Render are easier.

If you still want Vercel:
1. Convert `server.js` to serverless functions
2. Use Vercel's API routes
3. Deploy frontend separately

**Recommended:** Use Railway or Render instead for this project.

---

## 🔧 **POST-DEPLOYMENT CHECKLIST**

After deploying to any platform:

### **1. Test Your Deployment:**

```bash
# Replace with your actual URL
curl https://your-app.railway.app/api/health

# Should return:
{
  "status": "healthy",
  "timestamp": "2024-...",
  "apis": {
    "finnhub": true,
    "newsApi": true,
    "openai": true
  }
}
```

### **2. Test Stock Analysis:**
```bash
curl https://your-app.railway.app/api/analyze/AAPL
```

### **3. Open in Browser:**
- Visit: `https://your-app.railway.app`
- Try analyzing a stock
- Check all features work

### **4. Set Up Monitoring:**
- Check deployment logs
- Set up error alerts
- Monitor API usage

---

## 🎨 **CUSTOM DOMAIN (OPTIONAL)**

### **On Railway:**
1. Go to: Settings → Domains
2. Click: **Add Custom Domain**
3. Enter: `trading.yourdomain.com`
4. Add DNS record:
   ```
   Type: CNAME
   Name: trading
   Value: your-app.up.railway.app
   ```
5. Wait for DNS propagation (5-30 min)
6. ✅ Access at: `https://trading.yourdomain.com`

### **On Render:**
1. Go to: Settings → Custom Domains
2. Click: **Add Custom Domain**
3. Follow similar DNS steps

---

## 💰 **COST OPTIMIZATION**

### **Free Setup:**
```
Railway: $5 credit/month (free)
Finnhub: FREE (60 calls/min)
NewsAPI: FREE (100 calls/day)
= $0/month
```

### **Reduce OpenAI Costs:**

1. **Set Usage Limits:**
   - Go to: platform.openai.com/account/billing/limits
   - Set monthly limit: $10
   - Get alerts at 80%

2. **Use Caching:**
   - Cache analysis results for 5-10 minutes
   - Don't analyze same stock repeatedly

3. **Selective AI:**
   - Only use AI for important decisions
   - Use basic analysis for quick checks

---

## 🐛 **TROUBLESHOOTING**

### **"Application Error"**
- Check deployment logs
- Verify environment variables
- Check `npm start` works locally

### **"API Keys Not Working"**
- Verify keys in environment variables
- No extra spaces or quotes
- Restart/redeploy after adding keys

### **"Cannot GET /"**
- Check `public/index.html` exists
- Verify `express.static('public')` in server.js
- Check file paths are correct

### **"Port Already in Use"**
- Don't set PORT in .env for production
- Railway/Render set PORT automatically

### **"Out of Memory"**
- Increase instance size
- Check for memory leaks
- Reduce cached data

---

## 📊 **MONITORING**

### **Railway:**
- Dashboard shows: CPU, Memory, Network
- View logs: Click service → Logs
- Set alerts in settings

### **Render:**
- Dashboard → Metrics
- View logs: Dashboard → Events
- Email alerts available

### **Uptime Monitoring (Optional):**
- Use: https://uptimerobot.com (free)
- Monitor your URL
- Get alerts if down

---

## 🔄 **CONTINUOUS DEPLOYMENT**

Both Railway and Render auto-deploy on push:

```bash
# Make changes locally
git add .
git commit -m "Improve analysis algorithm"
git push origin main

# Railway/Render automatically:
# 1. Detects push
# 2. Runs npm install
# 3. Runs npm start
# 4. Deploys new version
# 5. Your site updates!
```

---

## 🎯 **RECOMMENDED SETUP**

For most users:

```
Platform: Railway
Database: None needed (in-memory)
APIs: Finnhub + NewsAPI (free)
AI: Optional OpenAI (if budget allows)

Cost: $0/month
Performance: Excellent
Difficulty: Easy
```

---

## ✅ **DEPLOYMENT SUCCESS CHECKLIST**

- [ ] Code pushed to GitHub
- [ ] Deployed to Railway/Render
- [ ] Environment variables added
- [ ] API health check passes
- [ ] Can analyze stocks
- [ ] Frontend loads correctly
- [ ] News displays properly
- [ ] Mobile version works
- [ ] Custom domain (optional)
- [ ] Monitoring set up

---

## 🎉 **YOU'RE LIVE!**

Your AI trading system is now running in the cloud!

**Share your URL:**
- Show to investors
- Add to resume
- Use for actual trading research
- Build your portfolio

**Next Steps:**
1. Test thoroughly
2. Monitor usage
3. Add more features
4. Scale as needed

---

## 📞 **NEED HELP?**

**Railway:**
- Docs: https://docs.railway.app
- Discord: https://discord.gg/railway

**Render:**
- Docs: https://render.com/docs
- Community: https://community.render.com

**Heroku:**
- Docs: https://devcenter.heroku.com
- Support: https://help.heroku.com

---

**Happy Deploying!** 🚀📈💰
