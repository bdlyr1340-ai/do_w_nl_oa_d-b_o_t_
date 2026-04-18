# Build stage
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn clean package assembly:single -DskipTests

# Run stage
FROM eclipse-temurin:17-jdk
RUN apt-get update && apt-get install -y ffmpeg python3 curl
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY --from=build /app/target/VidSaveBot-1.0-jar-with-dependencies.jar ./app.jar

CMD ["java", "-jar", "app.jar"]
