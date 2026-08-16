FROM traccar/traccar:latest

# Copy our custom cloud configuration file into the container
COPY setup/traccar-cloud.xml /opt/traccar/conf/traccar.xml
