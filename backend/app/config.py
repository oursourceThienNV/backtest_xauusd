from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_name: str = "VPS Backtest API"
    jwt_secret: str = "change-this-secret"
    jwt_expire_minutes: int = 1440
    db_host: str = "127.0.0.1"
    db_port: int = 3306
    db_name: str = "mt5_backtest"
    db_user: str = "root"
    db_password: str = ""
    cors_origins: str = "http://localhost:3000"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

settings = Settings()
