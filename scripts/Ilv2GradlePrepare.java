import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.Map;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ModelBuilder;
import org.gradle.tooling.ProjectConnection;
import org.gradle.tooling.model.eclipse.EclipseExternalDependency;
import org.gradle.tooling.model.eclipse.EclipseProject;

/** Resolves the same Eclipse and APT models used by the frozen JDT importer. */
public final class Ilv2GradlePrepare {
    private static void emit(String type, File file) throws Exception {
        emit(type, file.getCanonicalPath());
    }

    private static void emit(String type, String text) {
        String value = Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
        System.out.println("ILV2_PREPARE\t" + type + "\t" + value);
    }

    private static void visit(EclipseProject project) throws Exception {
        emit("PROJECT", project.getProjectDirectory());
        for (EclipseExternalDependency dependency : project.getClasspath()) {
            File file = dependency.getFile();
            if (!dependency.isResolved() || file == null || file.getName().endsWith(".jar") && !file.isFile()) {
                throw new IllegalStateException("Eclipse model contains an unresolved binary dependency");
            }
            emit(file.isFile() ? "BINARY" : "CLASSPATH_DIRECTORY", file);
            if (dependency.getSource() != null) emit("SOURCE_ATTACHMENT", dependency.getSource());
        }
        for (var source : project.getSourceDirectories()) emit("SOURCE_DIRECTORY", source.getDirectory());
        for (var dependency : project.getProjectDependencies()) emit("PROJECT_DEPENDENCY", dependency.getPath());
        for (var container : project.getClasspathContainers()) emit("CLASSPATH_CONTAINER", container.getPath());
        for (EclipseProject child : project.getChildren()) visit(child);
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 10) throw new IllegalArgumentException("frozen preparation arguments required");
        File repo = new File(args[0]);
        File home = new File(args[1]);
        File installation = new File(args[2]);
        File javaHome = new File(args[3]);
        String[] jvmArguments = Arrays.copyOfRange(args, 9, args.length);
        GradleConnector connector = GradleConnector.newConnector().forProjectDirectory(repo)
            .useInstallation(installation).useGradleUserHomeDir(home);
        try (ProjectConnection connection = connector.connect();
             FileOutputStream stdout = new FileOutputStream(args[7]);
             FileOutputStream stderr = new FileOutputStream(args[8])) {
            ModelBuilder<EclipseProject> eclipse = connection.model(EclipseProject.class)
                .setJavaHome(javaHome).setJvmArguments(jvmArguments)
                .withArguments("--init-script", args[4], "--init-script", args[5], "--info", "--stacktrace")
                .setStandardOutput(stdout).setStandardError(stderr);
            visit(eclipse.get());
            System.out.println("ILV2_PREPARE\tPHASE\tECLIPSE_MODEL_COMPLETE");

            // JDT 1.56 replaces operation arguments here. Persistent HOME and JVM
            // arguments remain effective; do not omit the real processor model.
            Map<?, ?> apt = connection.model(Map.class).setJavaHome(javaHome).setJvmArguments(jvmArguments)
                .withArguments("--init-script", args[6]).setStandardOutput(stdout).setStandardError(stderr).get();
            for (Map.Entry<?, ?> entry : apt.entrySet()) {
                if (!(entry.getKey() instanceof File) || !(entry.getValue() instanceof Map<?, ?>)) {
                    throw new IllegalStateException("invalid APT model entry");
                }
                emit("APT_PROJECT", (File) entry.getKey());
                Object processors = ((Map<?, ?>) entry.getValue()).get("processors");
                if (processors != null) {
                    if (!(processors instanceof Collection<?>)) throw new IllegalStateException("invalid processor collection");
                    for (Object processor : (Collection<?>) processors) {
                        if (!(processor instanceof File) || !((File) processor).isFile()) {
                            throw new IllegalStateException("APT model contains a missing processor binary");
                        }
                        emit("PROCESSOR", (File) processor);
                    }
                }
            }
            System.out.println("ILV2_PREPARE\tPHASE\tAPT_MODEL_COMPLETE");
        } finally {
            connector.disconnect();
        }
    }
}
