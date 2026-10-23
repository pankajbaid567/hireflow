from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from src.api.routes.profile import router as profile_router
from src.api.routes.weekly_plan import router as weekly_plan_router
from src.api.routes.applications import router as applications_router
from src.api.routes.resumes import router as resumes_router
from src.api.routes.reports import router as reports_router
from src.api.routes.hiring import router as hiring_router
from src.config.settings import get_settings
from src.config.database import get_db
from src.api.security import enforce_ownership
from src.api.routes.account import router as account_router

app = FastAPI(title="HireFlow API", dependencies=[Depends(enforce_ownership)])
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip() for origin in get_settings().allowed_origins.split(",")
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)
app.include_router(account_router)
app.include_router(profile_router)
app.include_router(weekly_plan_router)
app.include_router(applications_router)
app.include_router(resumes_router)
app.include_router(reports_router)
app.include_router(hiring_router)


@app.middleware("http")
async def private_response_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/health")
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(503, "Database unavailable") from exc
    return {"status": "ok"}


@app.get("/")
def read_root():
    return {"message": "HireFlow API is running"}
