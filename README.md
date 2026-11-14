# Longevity Plate 网页版（家庭版）部署说明

家里人用邮箱登录就能用，不需要 claude.ai 账号。数据存在你自己的 Supabase，AI 用你的 Anthropic API 密钥。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 应用本体（和 claude.ai 里那版界面相同） |
| `lp-standalone.js` | 把应用接到 Supabase：登录、数据库、AI |
| `config.js` | 填你的 Supabase 地址和公开密钥 |
| `supabase/schema.sql` | 数据表和权限规则 |
| `supabase/functions/ai/index.ts` | AI 接口，密钥只放在服务器上，每人每天有调用上限 |
| `build.py` | 从共享源码重新生成 `index.html`（以后改了应用再用） |

## 一次性设置（约 30 分钟）

### 1. 建 Supabase 项目
1. 在 supabase.com 新建项目，**Region 选 Canada (Central)**，健康数据留在加拿大。
2. 打开 **SQL Editor**，把 `supabase/schema.sql` 全部粘贴进去运行。

### 2. 登录设置
在 **Authentication** 里：
1. **Sign In / Providers → Email**：保持开启。
2. **关闭 "Allow new users to sign up"**，这样只有你邀请的人能登录。
3. **URL Configuration**：Site URL 填你部署后的网址（第 5 步得到），Redirect URLs 也加上同一个网址。
4. 免费版自带邮件每小时只能发几封。家里人多的话，在 **SMTP Settings** 接一个邮件服务（比如 Resend）。

### 3. 部署 AI 接口
在电脑上装好 Supabase CLI，然后在这个文件夹里运行：

```bash
supabase login
supabase link --project-ref 你的项目ID
supabase secrets set ANTHROPIC_API_KEY=sk-ant-你的密钥
supabase functions deploy ai
```

可选设置：
- `DAILY_CAP=80`：每人每天最多调用 AI 的次数（默认 80）
- `MODEL_DEFAULT` / `MODEL_QUICK` / `MODEL_COMPLEX`：换模型

### 4. 填 config.js
在 **Project Settings → API** 复制 Project URL 和 anon public key，填进 `config.js`。
anon key 本来就是公开的，数据靠 `schema.sql` 里的权限规则保护，每个人只能读写自己的数据。

### 5. 发布网页
整个文件夹（除了 `supabase/`）是纯静态网页，任选一种：
- **Vercel**：`npx vercel deploy --prod`，或者把文件夹拖进 vercel.com
- **Netlify**：把文件夹拖进 app.netlify.com/drop

拿到网址后回到第 2 步，填进 Site URL。

### 6. 邀请家人、设自己为管理员
1. **Authentication → Users → Invite user**，输入家人的邮箱，对方会收到邀请邮件。
2. 先邀请你自己并登录一次，然后在 SQL Editor 运行（换成你的邮箱）：
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = '你的邮箱';
   ```
   之后「洞察」页会出现管理员工具。

## 把 claude.ai 版里的数据搬过来
1. 在 claude.ai 版打开「档案」，拉到最下面「我的数据」，点「复制我的全部数据」。
2. 在网页版登录后，同样位置粘贴到「导入数据」，点两次确认。

导出包含档案、所有化验报告和最近 60 天的饮食记录。

## 费用参考
- Supabase 免费版：500MB 数据库，家庭使用足够。
- Anthropic API：按用量计费。一餐分析通常是几美分，具体看照片数量和模型，以 Anthropic 当前价格为准。可以在 console.anthropic.com 设每月上限。

## 安全说明
- 每个人的数据只有本人能读写（数据库行级权限），你作为管理员也看不到别人的档案。
- 匿名研究默认关闭，打开后只分享年龄段、性别和化验数值。
- AI 密钥只存在 Supabase 服务器上，不会出现在网页里。

## 邀请新家人后（重要）
Supabase 把「已邀请但还没点邀请链接」的账号当作未注册，这时在网站上输入邮箱会提示 "Signups not allowed"。
对方点邀请邮件里的链接就能解决。也可以在 SQL Editor 直接确认邮箱：

```sql
update auth.users set email_confirmed_at = now()
where email_confirmed_at is null and email = '新家人的邮箱';
```
