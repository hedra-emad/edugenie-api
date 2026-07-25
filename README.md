# EduGenie API

The backend for **EduGenie**, an AI-powered e-learning platform. Built with **NestJS**, **TypeScript** and **MongoDB**, it exposes **188 REST endpoints across 32 feature modules** and powers course delivery, payments, certification, and an AI study coach backed by a Retrieval-Augmented Generation (RAG) pipeline.

**Live:** https://edugenie-api.vercel.app  ·  **Swagger docs:** `/api/docs`
**Frontends:** [Student web app](https://github.com/hedra-emad/edugenie-student-web) · [Admin dashboard](https://github.com/hedra-emad/edugenie-dashboard)

---

## Features

**AI & RAG**
- Retrieval-Augmented Generation pipeline: document chunking → embeddings → indexing → semantic retrieval
- AI study coach with scheduled missions, auto-generated learning roadmaps, and practice/remediation flows
- Lecture transcription behind a swappable provider interface (OpenAI and Google Gemini)

**Learning**
- Courses, sections, lessons, enrollments, progress tracking, notes
- Quizzes, placement tests, and reporting
- PDF certificates with QR-code verification

**Commerce**
- Cart, orders and checkout
- Stripe Connect (Express accounts, destination charges, signature-verified webhooks)
- Automated instructor payouts and earnings

**Platform**
- JWT + Google OAuth 2.0 authentication (Passport)
- Role-based access control: student, instructor, admin, super-admin
- Real-time notifications and AI chat over Socket.IO and Pusher
- Cloudinary media storage, transactional email, audit logs
- Helmet, request rate limiting, DTO validation, Joi-validated environment config

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 11, TypeScript 5 |
| Database | MongoDB, Mongoose |
| Auth | JWT, Passport, Google OAuth 2.0 |
| Payments | Stripe Connect |
| Real-time | Socket.IO, Pusher |
| AI | OpenAI API, Google Gemini API |
| Media | Cloudinary |
| Docs | Swagger / OpenAPI |
| Testing | Jest (33 test suites) |
| Deployment | Vercel, Railway |

---

## Getting Started

```bash
npm install
cp .env.example .env      # then fill in the values below
npm run start:dev         # http://localhost:5000
```

### Environment variables

```bash
MONGODB_URI=
JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OPENAI_API_KEY=
GEMINI_API_KEY=
CLOUDINARY_URL=
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Payment endpoints return `503` when Stripe keys are absent — the app still boots. Full payment setup and an end-to-end demo script are documented in [`STRIPE_CONNECT_DEMO.md`](./STRIPE_CONNECT_DEMO.md).

### Scripts

```bash
npm run start:dev     # watch mode
npm run test          # unit tests
npm run test:cov      # coverage
npm run test:e2e      # end-to-end tests
npm run seed          # seed the database
npm run lint          # ESLint + Prettier
```

---

## Project Structure

```
src/
├── ai/              # AI coach, roadmap, practice, remediation, transcription providers
├── rag/             # chunking, embeddings, indexing, retrieval
├── auth/            # JWT + Google OAuth
├── courses/         # courses, sections, lessons
├── enrollments/     # enrollment and progress
├── quizzes/         # quizzes and placement tests
├── payments/        # Stripe Connect, orders, cart
├── earnings/        # instructor payouts
├── certificates/    # PDF generation + QR verification
├── notifications/   # Socket.IO + Pusher gateways
├── admin/ superadmin/ instructor/
└── common/          # guards, interceptors, filters, DTOs
```

---

## Team

Built by a 5-developer team as the graduation project for the **ITI Intensive Code Camp — Full-Stack Web & Generative AI Development using MERN**.

Maintainer: [Hedra Emad](https://github.com/hedra-emad) — Team Leader
