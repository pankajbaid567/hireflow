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

app = FastAPI(title="HireFlow API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip() for origin in get_settings().allowed_origins.split(",")
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(profile_router)
app.include_router(weekly_plan_router)
app.include_router(applications_router)
app.include_router(resumes_router)
app.include_router(reports_router)
app.include_router(hiring_router)


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
